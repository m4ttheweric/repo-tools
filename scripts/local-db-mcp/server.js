import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

const connectionString =
  process.env.POSTGRES_URL ||
  "postgresql://postgres:postgres@localhost:5432/assured?connect_timeout=300";

const pool = new pg.Pool({ connectionString, max: 3 });

const server = new McpServer({
  name: "local-db",
  version: "1.0.0",
  description:
    "Direct access to the local database, local DB, development database, dev DB, dev database. " +
    "Use this server for any database queries, data inspection, or data manipulation on the local Postgres instance.",
});

server.tool(
  "query",
  "Run a SQL query against the local database (local DB, development database, dev DB, dev database). Returns rows as JSON. Use for SELECT, INSERT, UPDATE, DELETE, or any valid SQL.",
  { sql: z.string().describe("The SQL query to execute") },
  async ({ sql }) => {
    try {
      const result = await pool.query(sql);
      const output = {
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows?.slice(0, 500),
      };
      if (result.rows?.length > 500) {
        output.truncated = true;
        output.totalRows = result.rows.length;
      }
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `SQL Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "list_tables",
  "List all tables in the local database (local DB, dev DB, development database) with row counts.",
  { schema: z.string().optional().default("public").describe("Schema name (default: public)") },
  async ({ schema }) => {
    try {
      const result = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
        [schema],
      );
      const tables = result.rows.map((r) => r.tablename);

      const counts = await Promise.all(
        tables.slice(0, 100).map(async (t) => {
          try {
            const c = await pool.query(`SELECT COUNT(*)::int as count FROM "${t}"`);
            return { table: t, rows: c.rows[0].count };
          } catch {
            return { table: t, rows: "error" };
          }
        }),
      );

      return { content: [{ type: "text", text: JSON.stringify(counts, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "describe_table",
  "Describe a table's columns, types, and constraints in the local database (local DB, dev DB, dev database).",
  { table: z.string().describe("Table name (case-sensitive, use PascalCase as Prisma generates)") },
  async ({ table }) => {
    try {
      const cols = await pool.query(
        `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns
         WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`,
        [table],
      );

      const fks = await pool.query(
        `SELECT
           kcu.column_name,
           ccu.table_name AS foreign_table,
           ccu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
        [table],
      );

      const indexes = await pool.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`,
        [table],
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                table,
                columns: cols.rows,
                foreignKeys: fks.rows,
                indexes: indexes.rows,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
