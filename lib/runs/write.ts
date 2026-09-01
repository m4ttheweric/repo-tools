/**
 * The run DB's write side: schema, migration, and every mutation the
 * pipeline records. Functions take an open Database and plain arguments and
 * return what the CLI prints, so commands/runs-write.ts stays parsing and
 * printing only.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { recordIdentity } from "./identity.ts";

export const KNOWN_SCHEMA_VERSION = 2;

export type Fail = { ok: false; error: string; code: 1 | 2 | 3 };
export type Ok<T extends object = {}> = { ok: true } & T;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, work_type TEXT NOT NULL,
  pipeline TEXT NOT NULL, status TEXT NOT NULL, current_stage TEXT,
  spawned_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  pack_commits TEXT, pack_dirty INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS stages (
  run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER, ended_at INTEGER, reason TEXT, detail_path TEXT,
  PRIMARY KEY (run_id, name, attempt));
CREATE TABLE IF NOT EXISTS fields (
  run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL,
  value TEXT NOT NULL, produced_by TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (run_id, key));
CREATE TABLE IF NOT EXISTS decisions (
  run_id TEXT NOT NULL REFERENCES runs(id), contract TEXT NOT NULL,
  scope TEXT NOT NULL, selection TEXT NOT NULL, decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL, PRIMARY KEY (run_id, contract, scope));
`;

function columns(db: Database, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name);
}

// Each ALTER is independently tolerant so a half-applied migration from an
// interrupted call converges on the next one. The version is stamped only
// once the columns are really there: an ALTER that failed for any reason
// other than duplicate-column must not leave a stamped DB that never
// migrated.
export function migrate(db: Database): void {
  const have = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (have >= KNOWN_SCHEMA_VERSION) return;
  const add = (table: string, col: string, decl: string) => {
    if (!columns(db, table).includes(col)) db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  };
  add("stages", "reason", "TEXT");
  add("stages", "detail_path", "TEXT");
  add("runs", "pack_commits", "TEXT");
  add("runs", "pack_dirty", "INTEGER DEFAULT 0");
  if (columns(db, "stages").includes("reason") && columns(db, "runs").includes("pack_commits")) {
    db.run(`PRAGMA user_version=${KNOWN_SCHEMA_VERSION}`);
  }
}

export function createRunDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");
  db.run(SCHEMA_SQL);
  migrate(db);
  return db;
}

export function openRunDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA busy_timeout=5000");
  migrate(db);
  return db;
}

const RUN_STATUSES = new Set(["done", "failed", "abandoned"]);

export function runStatus(db: Database, status: string, now: number = Date.now()): Ok | Fail {
  if (!RUN_STATUSES.has(status)) return { ok: false, error: "run-status needs --status done|failed|abandoned", code: 2 };
  try {
    db.run("UPDATE runs SET status=?, ended_at=?", [status, now]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

export function stageStart(db: Database, name: string, env: NodeJS.ProcessEnv, now: number = Date.now()): Ok | Fail {
  try {
    db.run(
      `INSERT INTO stages (run_id, name, status, attempt, started_at)
       SELECT id, ?, 'running', COALESCE((SELECT MAX(attempt) FROM stages WHERE name = ?), 0) + 1, ? FROM runs`,
      [name, name, now],
    );
    db.run("UPDATE runs SET current_stage=?", [name]);
    recordIdentity(db, env, now);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

function changes(db: Database): number {
  return (db.query("SELECT changes() AS n").get() as { n: number }).n;
}

// A zero-row update means stage-start never landed (skipped, or refused by
// the caller's shell guard); answering ok there once left a run with no row
// for the stage and nothing telling the agent to retry.
export function stageEnd(
  db: Database,
  name: string,
  status: "done" | "failed",
  opts: { reason?: string; detailPath?: string; now?: number } = {},
): Ok | Fail {
  try {
    db.run(
      `UPDATE stages SET status=?, ended_at=?, reason=?, detail_path=?
       WHERE name=? AND attempt=(SELECT MAX(attempt) FROM stages WHERE name=?)`,
      [status, opts.now ?? Date.now(), opts.reason ?? null, opts.detailPath ?? null, name, name],
    );
    if (changes(db) === 0) return { ok: false, error: `stage never started: ${name}`, code: 3 };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

export function fieldSet(db: Database, key: string, value: string, stage: string, now: number = Date.now()): Ok | Fail {
  try {
    db.run("INSERT OR REPLACE INTO fields (run_id, key, value, produced_by, at) SELECT id, ?, ?, ?, ? FROM runs", [key, value, stage, now]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

export function fieldGet(db: Database, key: string): Ok<{ value: string }> | Fail {
  const row = db.query("SELECT value FROM fields WHERE key=?").get(key) as { value: string } | undefined;
  if (!row || row.value === "") return { ok: false, error: `no field ${key}`, code: 3 };
  return { ok: true, value: row.value };
}

export function decisionRecord(
  db: Database,
  o: { contract: string; scope: string; selection: string; decidedBy: string; now?: number },
): Ok | Fail {
  try {
    JSON.parse(o.selection);
  } catch {
    return { ok: false, error: "--selection must be JSON", code: 2 };
  }
  try {
    db.run(
      "INSERT OR REPLACE INTO decisions (run_id, contract, scope, selection, decided_by, decided_at) SELECT id, ?, ?, ?, ?, ? FROM runs",
      [o.contract, o.scope, o.selection, o.decidedBy, o.now ?? Date.now()],
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  }
}

export type Row = Record<string, unknown>;

// Raw rows from the open handle, not store.ts's readRun: that one keys on
// (repo, runId) under runsRoot() and returns the enriched RunDetail shape,
// while callers of snapshot expect the table rows the script printed.
export function snapshot(db: Database): Ok<{ run: Row | null; stages: Row[]; fields: Row[]; decisions: Row[] }> | Fail {
  try {
    return {
      ok: true,
      run: (db.query("SELECT * FROM runs LIMIT 1").get() as Row | undefined) ?? null,
      stages: db.query("SELECT * FROM stages ORDER BY started_at, attempt").all() as Row[],
      fields: db.query("SELECT * FROM fields ORDER BY at").all() as Row[],
      decisions: db.query("SELECT * FROM decisions ORDER BY decided_at").all() as Row[],
    };
  } catch (err) {
    return { ok: false, error: `sqlite read failed: ${String(err)}`, code: 1 };
  }
}

export function runIdentity(db: Database): { repo: string; runId: string } | null {
  const row = db.query("SELECT id, repo FROM runs LIMIT 1").get() as { id: string; repo: string } | undefined;
  return row ? { repo: row.repo, runId: row.id } : null;
}
