/**
 * The run DB's write side: schema, migration, and every mutation the
 * pipeline records. Functions take an open Database and plain arguments and
 * return what the CLI prints, so commands/runs-write.ts stays parsing and
 * printing only.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

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
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

export function openRunDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA busy_timeout=5000");
  migrate(db);
  return db;
}
