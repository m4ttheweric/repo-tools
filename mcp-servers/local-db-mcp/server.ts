import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────────────

interface QueryOutput {
  command: string;
  rowCount: number | null;
  rows: Record<string, unknown>[];
  truncated?: boolean;
  totalRows?: number;
}

interface TableCount {
  table: string;
  rows: number | "error";
}

// ── Database ─────────────────────────────────────────────────────────────────

const connectionString =
  process.env.POSTGRES_URL ||
  "postgresql://postgres:postgres@localhost:5432/assured?connect_timeout=300";

const pool = new pg.Pool({ connectionString, max: 3 });

// ── Server ───────────────────────────────────────────────────────────────────

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
      const output: QueryOutput = {
        command: result.command,
        rowCount: result.rowCount,
        rows: result.rows?.slice(0, 500),
      };
      if (result.rows?.length > 500) {
        output.truncated = true;
        output.totalRows = result.rows.length;
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `SQL Error: ${message}` }], isError: true };
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
      const tables: string[] = result.rows.map((r: { tablename: string }) => r.tablename);

      const counts: TableCount[] = await Promise.all(
        tables.slice(0, 100).map(async (t) => {
          try {
            const c = await pool.query(`SELECT COUNT(*)::int as count FROM "${t}"`);
            return { table: t, rows: c.rows[0].count as number };
          } catch {
            return { table: t, rows: "error" as const };
          }
        }),
      );

      return { content: [{ type: "text" as const, text: JSON.stringify(counts, null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
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
            type: "text" as const,
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  },
);

// ── Transport ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
