import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

interface Favorite {
  entity_type: string;
  entity_id: string;
  label: string | null;
  notes: string | null;
  created_at: string;
}

type InvestigationState =
  | "in-progress"
  | "expired-partial"
  | "expired-empty"
  | "completed"
  | "not-started";

// ── Config ───────────────────────────────────────────────────────────────────

const dbLabel = process.env.DB_LABEL || "local";
const dbSchema = process.env.DB_SCHEMA || "public";

// ── Databases ────────────────────────────────────────────────────────────────

const connectionString =
  process.env.POSTGRES_URL ||
  "postgresql://postgres:postgres@localhost:5432/assured?connect_timeout=300";

const pool = new pg.Pool({ connectionString, max: 3 });

// Set search_path on every new connection so unqualified table names resolve correctly
pool.on("connect", (client) => {
  client.query(`SET search_path TO "${dbSchema}", public`);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const favoritesDb = new Database(join(__dirname, "favorites.db"));
favoritesDb.pragma("journal_mode = WAL");
favoritesDb.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('case', 'claim')),
    entity_id TEXT NOT NULL,
    label TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(entity_type, entity_id)
  )
`);

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function textResponse(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ── Postgres Queries ─────────────────────────────────────────────────────────

async function getCaseSummary(caseId: string) {
  const result = await pool.query(
    `SELECT
       c.id, c."externalId", c.type, c."investigationBeganAt",
       (SELECT count(*) FROM "CaseContact" cc WHERE cc."caseId" = c.id) as contact_count,
       (SELECT count(*) FROM "Claim" cl
        WHERE cl."caseContactId" IN (SELECT cc2.id FROM "CaseContact" cc2 WHERE cc2."caseId" = c.id)
          AND cl."submittedAt" IS NOT NULL
       ) as completed_investigations,
       (SELECT string_agg(cc3.name, ', ' ORDER BY cc3."createdAt")
        FROM "CaseContact" cc3 WHERE cc3."caseId" = c.id
       ) as contacts
     FROM "Case" c WHERE c.id = $1`,
    [caseId],
  );
  return result.rows[0] ?? null;
}

async function getClaimSummary(claimId: string) {
  const result = await pool.query(
    `SELECT
       cl.id, cl."collectionMode", cl."submittedAt", cl."caseContactId",
       cl."driverWasInjured", cl."anyoneInjured",
       cl."generatedInvestigationCaseId" as case_id,
       cc.name as contact_name
     FROM "Claim" cl
     LEFT JOIN "CaseContact" cc ON cc.id = cl."caseContactId"
     WHERE cl.id = $1`,
    [claimId],
  );
  return result.rows[0] ?? null;
}

async function detectEntityType(id: string): Promise<"case" | "claim"> {
  const caseResult = await pool.query(
    `SELECT id FROM "Case" WHERE id = $1`,
    [id],
  );
  if (caseResult.rows.length > 0) return "case";

  const claimResult = await pool.query(
    `SELECT id FROM "Claim" WHERE id = $1`,
    [id],
  );
  return claimResult.rows.length > 0 ? "claim" : "case";
}

async function findClaimForContact(contactId: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT id FROM "Claim" WHERE "caseContactId" = $1 LIMIT 1`,
    [contactId],
  );
  return result.rows.length > 0 ? (result.rows[0].id as string) : null;
}

async function upsertActivitySession(
  claimId: string,
  lastSeenOffset: string,
  initiatedOffset: string,
): Promise<string> {
  const existing = await pool.query(
    `SELECT id FROM "ActivitySession" WHERE "claimId" = $1 LIMIT 1`,
    [claimId],
  );
  if (existing.rows.length > 0) {
    await pool.query(
      `UPDATE "ActivitySession"
       SET "lastSeenAt" = NOW() - INTERVAL '${lastSeenOffset}',
           "initiatedAt" = NOW() - INTERVAL '${initiatedOffset}'
       WHERE "claimId" = $1`,
      [claimId],
    );
    return "Updated ActivitySession timestamps";
  }
  await pool.query(
    `INSERT INTO "ActivitySession" (id, "claimId", "lastSeenAt", "initiatedAt")
     VALUES (gen_random_uuid()::text, $1, NOW() - INTERVAL '${lastSeenOffset}', NOW() - INTERVAL '${initiatedOffset}')`,
    [claimId],
  );
  return "Created ActivitySession";
}

async function deleteActivitySessions(claimId: string) {
  await pool.query(`DELETE FROM "ActivitySession" WHERE "claimId" = $1`, [
    claimId,
  ]);
}

async function setInvestigationTimer(caseId: string, offset: string | null) {
  if (offset) {
    await pool.query(
      `UPDATE "Case" SET "investigationBeganAt" = NOW() - INTERVAL '${offset}' WHERE id = $1`,
      [caseId],
    );
  } else {
    await pool.query(
      `UPDATE "Case" SET "investigationBeganAt" = NOW() WHERE id = $1`,
      [caseId],
    );
  }
}

async function setClaimSubmitted(claimId: string, submitted: boolean) {
  if (submitted) {
    await pool.query(
      `UPDATE "Claim" SET "submittedAt" = NOW() WHERE id = $1`,
      [claimId],
    );
  } else {
    await pool.query(
      `UPDATE "Claim" SET "submittedAt" = NULL WHERE id = $1`,
      [claimId],
    );
  }
}

// ── Investigation State Logic ────────────────────────────────────────────────

const stateConfigs: Record<
  InvestigationState,
  {
    submitted: boolean;
    timerOffset: string | null;
    session: { lastSeen: string; initiated: string } | "delete";
  }
> = {
  "in-progress": {
    submitted: false,
    timerOffset: null,
    session: { lastSeen: "30 minutes", initiated: "45 minutes" },
  },
  "expired-partial": {
    submitted: false,
    timerOffset: "5 days",
    session: { lastSeen: "4 days", initiated: "4 days" },
  },
  "expired-empty": {
    submitted: false,
    timerOffset: "5 days",
    session: "delete",
  },
  "not-started": {
    submitted: false,
    timerOffset: null,
    session: "delete",
  },
  completed: {
    submitted: true,
    timerOffset: null,
    session: { lastSeen: "1 hour", initiated: "2 hours" },
  },
};

async function applyInvestigationState(
  caseId: string,
  claimId: string,
  state: InvestigationState,
): Promise<string[]> {
  const config = stateConfigs[state];
  const changes: string[] = [];

  await setClaimSubmitted(claimId, config.submitted);
  changes.push(
    config.submitted
      ? "Set claim.submittedAt = NOW()"
      : "Set claim.submittedAt = NULL",
  );

  await setInvestigationTimer(caseId, config.timerOffset);
  changes.push(
    config.timerOffset
      ? `Set case.investigationBeganAt = ${config.timerOffset} ago (timer expired)`
      : "Set case.investigationBeganAt = NOW() (timer running)",
  );

  if (config.session === "delete") {
    await deleteActivitySessions(claimId);
    changes.push("Removed all ActivitySessions (no engagement)");
  } else {
    const msg = await upsertActivitySession(
      claimId,
      config.session.lastSeen,
      config.session.initiated,
    );
    changes.push(msg);
  }

  return changes;
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: `${dbLabel}-db`,
  version: "1.1.0",
  description:
    `Direct access to the ${dbLabel} database. ` +
    `Use this server for any database queries, data inspection, or data manipulation on the ${dbLabel} Postgres instance.`,
});

// ── Generic Database Tools ───────────────────────────────────────────────────

server.tool(
  "query",
  `Run a SQL query against the ${dbLabel} database. Returns rows as JSON. Use for SELECT, INSERT, UPDATE, DELETE, or any valid SQL.`,
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
      return jsonResponse(output);
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "list_tables",
  `List all tables in the ${dbLabel} database with row counts.`,
  {
    schema: z
      .string()
      .optional()
      .default(dbSchema)
      .describe(`Schema name (default: ${dbSchema})`),
  },
  async ({ schema }) => {
    try {
      const result = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
        [schema],
      );
      const tables: string[] = result.rows.map(
        (r: { tablename: string }) => r.tablename,
      );

      const counts: TableCount[] = await Promise.all(
        tables.slice(0, 100).map(async (t) => {
          try {
            const c = await pool.query(
              `SELECT COUNT(*)::int as count FROM "${t}"`,
            );
            return { table: t, rows: c.rows[0].count as number };
          } catch {
            return { table: t, rows: "error" as const };
          }
        }),
      );

      return jsonResponse(counts);
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "describe_table",
  `Describe a table's columns, types, and constraints in the ${dbLabel} database.`,
  {
    table: z
      .string()
      .describe(
        "Table name (case-sensitive, use PascalCase as Prisma generates)",
      ),
  },
  async ({ table }) => {
    try {
      const [cols, fks, indexes] = await Promise.all([
        pool.query(
          `SELECT column_name, data_type, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
           WHERE table_name = $1 AND table_schema = $2
           ORDER BY ordinal_position`,
          [table, dbSchema],
        ),
        pool.query(
          `SELECT
             kcu.column_name,
             ccu.table_name AS foreign_table,
             ccu.column_name AS foreign_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = $2`,
          [table, dbSchema],
        ),
        pool.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = $2`,
          [table, dbSchema],
        ),
      ]);

      return jsonResponse({
        table,
        columns: cols.rows,
        foreignKeys: fks.rows,
        indexes: indexes.rows,
      });
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ── Investigation Tools ──────────────────────────────────────────────────────

server.tool(
  "find_cases",
  `Search for cases in the ${dbLabel} database. Returns recent investigation cases with contact counts, FNOL status, and investigation progress.`,
  {
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Max results (default 10)"),
    search: z
      .string()
      .optional()
      .describe("Search by case ID, external ID, or contact name"),
    hasInjuries: z
      .boolean()
      .optional()
      .describe("Filter to cases whose FNOL has injury data"),
  },
  async ({ limit, search, hasInjuries }) => {
    try {
      let whereClause = `c.type = 'INVESTIGATION'`;
      const params: (string | number)[] = [];
      let paramIdx = 1;

      if (search) {
        whereClause += ` AND (
          c.id ILIKE $${paramIdx}
          OR c."externalId" ILIKE $${paramIdx}
          OR EXISTS (SELECT 1 FROM "CaseContact" cc2 WHERE cc2."caseId" = c.id AND cc2.name ILIKE $${paramIdx})
        )`;
        params.push(`%${search}%`);
        paramIdx++;
      }

      if (hasInjuries) {
        whereClause += ` AND fnol."driverWasInjured" = true`;
      }

      params.push(limit);

      const result = await pool.query(
        `SELECT
           c.id as case_id, c."externalId" as external_id, c.type,
           c."investigationBeganAt", c."createdAt",
           fnol.id as fnol_claim_id, fnol."submittedAt" as fnol_submitted,
           fnol."driverWasInjured" as has_injuries,
           (SELECT count(*) FROM "CaseContact" cc WHERE cc."caseId" = c.id) as contact_count,
           (SELECT count(*) FROM "Claim" cl
            WHERE cl."caseContactId" IN (SELECT cc3.id FROM "CaseContact" cc3 WHERE cc3."caseId" = c.id)
              AND cl."submittedAt" IS NOT NULL
           ) as completed_investigations,
           (SELECT string_agg(cc4.name, ', ' ORDER BY cc4."createdAt")
            FROM "CaseContact" cc4 WHERE cc4."caseId" = c.id
           ) as contact_names
         FROM "Case" c
         LEFT JOIN "Claim" fnol ON fnol."generatedInvestigationCaseId" = c.id AND fnol."caseContactId" IS NULL
         WHERE ${whereClause}
         ORDER BY c."createdAt" DESC
         LIMIT $${paramIdx}`,
        params,
      );
      return jsonResponse(result.rows);
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "list_case_contacts",
  "List all contacts for a case with their current investigation state, claim IDs, and engagement status.",
  { caseId: z.string().describe("The Case ID") },
  async ({ caseId }) => {
    try {
      const result = await pool.query(
        `SELECT
           cc.id as contact_id, cc.name, cc.types,
           cl.id as claim_id, cl."submittedAt", cl."collectionMode",
           io."shouldContact", io."disabledReason",
           c."investigationBeganAt",
           (SELECT MAX(acs."lastSeenAt")
            FROM "ActivitySession" acs
            JOIN "Workflow" w ON w.id = acs."workflowId"
            WHERE acs."claimId" = cl.id AND w."workflowType" != 'out_of_band_workflow'
           ) as last_engaged,
           CASE
             WHEN cl."submittedAt" IS NOT NULL THEN 'completed'
             WHEN io."shouldContact" = false OR io."disabledReason" IS NOT NULL THEN 'disabled'
             WHEN (SELECT MAX(acs2."lastSeenAt") FROM "ActivitySession" acs2 WHERE acs2."claimId" = cl.id) IS NOT NULL
               AND c."investigationBeganAt" + INTERVAL '72 hours' < NOW() THEN 'expired-partial'
             WHEN c."investigationBeganAt" + INTERVAL '72 hours' < NOW() THEN 'expired-empty'
             WHEN (SELECT MAX(acs3."lastSeenAt") FROM "ActivitySession" acs3 WHERE acs3."claimId" = cl.id) IS NOT NULL THEN 'in-progress'
             ELSE 'not-started'
           END as investigation_status
         FROM "CaseContact" cc
         JOIN "Case" c ON c.id = cc."caseId"
         LEFT JOIN "Claim" cl ON cl."caseContactId" = cc.id
         LEFT JOIN "CaseContactInvestigationOptions" io ON io."caseContactId" = cc.id
         WHERE cc."caseId" = $1
         ORDER BY cc."createdAt"`,
        [caseId],
      );
      return jsonResponse(result.rows);
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "set_investigation_state",
  "Set a contact's investigation into a specific state for testing. Manipulates submittedAt, investigationBeganAt, and ActivitySession records as needed.",
  {
    caseId: z.string().describe("The Case ID"),
    contactId: z.string().describe("The CaseContact ID"),
    state: z
      .enum([
        "in-progress",
        "expired-partial",
        "expired-empty",
        "completed",
        "not-started",
      ])
      .describe("Target investigation state"),
  },
  async ({ caseId, contactId, state }) => {
    try {
      const claimId = await findClaimForContact(contactId);
      if (!claimId) {
        return textResponse(`No claim found for contact ${contactId}`);
      }

      const changes = await applyInvestigationState(caseId, claimId, state);

      return jsonResponse({ caseId, contactId, claimId, targetState: state, changes });
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ── Favorites Tools ──────────────────────────────────────────────────────────

server.tool(
  "add_favorite",
  "Add a case or claim to your favorites list with an optional label and notes. If already favorited, updates the label and notes.",
  {
    id: z.string().describe("The Case ID or Claim ID to favorite"),
    type: z
      .enum(["case", "claim"])
      .optional()
      .describe("Whether this is a case or claim (auto-detected if omitted)"),
    label: z
      .string()
      .optional()
      .describe("Short label for quick identification"),
    notes: z.string().optional().describe("Any notes about why this is saved"),
  },
  async ({ id, type, label, notes }) => {
    try {
      const entityType = type ?? (await detectEntityType(id));

      favoritesDb
        .prepare(
          `INSERT INTO favorites (entity_type, entity_id, label, notes) VALUES (?, ?, ?, ?)
           ON CONFLICT(entity_type, entity_id) DO UPDATE SET label = excluded.label, notes = excluded.notes`,
        )
        .run(entityType, id, label ?? null, notes ?? null);

      return textResponse(
        `Favorited ${entityType} ${id}${label ? ` as "${label}"` : ""}`,
      );
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "remove_favorite",
  "Remove a case or claim from your favorites list.",
  { id: z.string().describe("The Case ID or Claim ID to remove") },
  async ({ id }) => {
    try {
      const result = favoritesDb
        .prepare(`DELETE FROM favorites WHERE entity_id = ?`)
        .run(id);
      return textResponse(
        result.changes === 0
          ? `${id} was not in favorites`
          : `Removed ${id} from favorites`,
      );
    } catch (err) {
      return errorResponse(err);
    }
  },
);

server.tool(
  "list_favorites",
  `List all favorited cases and claims with their labels, notes, and current status from the ${dbLabel} database.`,
  {},
  async () => {
    try {
      const favorites = favoritesDb
        .prepare(`SELECT * FROM favorites ORDER BY created_at DESC`)
        .all() as Favorite[];

      if (favorites.length === 0) {
        return textResponse("No favorites yet.");
      }

      const enriched = await Promise.all(
        favorites.map(async (fav) => {
          try {
            const data =
              fav.entity_type === "case"
                ? await getCaseSummary(fav.entity_id)
                : await getClaimSummary(fav.entity_id);
            return { ...fav, exists: !!data, ...(data ?? {}) };
          } catch {
            return { ...fav, exists: false };
          }
        }),
      );

      return jsonResponse(enriched);
    } catch (err) {
      return errorResponse(err);
    }
  },
);

// ── Transport ────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
