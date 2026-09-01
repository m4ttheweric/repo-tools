/**
 * The run DB's write side: schema, migration, and every mutation the
 * pipeline records. Functions take an open Database and plain arguments and
 * return what the CLI prints, so commands/runs-write.ts stays parsing and
 * printing only.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { isPathComponent } from "./paths.ts";
import { composePackCommits, packProvenance } from "./provenance.ts";
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

export type RunStartOpts = {
  repo: string; workType: string; pipeline: string;
  runId?: string; spawnedBy?: string; packDirs?: string[]; ticket?: string;
  mattstackSha?: string; mattstackDirty?: boolean; packSha?: string;
  env?: NodeJS.ProcessEnv; now?: number;
};

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

// Same shape the shell helper minted: local wall clock, four random hex
// digits, the pid. Run ids sort by start time within a repo dir.
function newRunId(now: number): string {
  const d = new Date(now);
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
  return `${date}-${time}-${rand}-${process.pid}`;
}

const RUN_STATUSES = new Set(["done", "failed", "abandoned"]);

export function runStart(root: string, o: RunStartOpts): Ok<{ runId: string; runDb: string }> | Fail {
  if (!isPathComponent(o.repo)) return { ok: false, error: `--repo must be a single path component: ${o.repo}`, code: 2 };
  const now = o.now ?? Date.now();
  const runId = o.runId ?? newRunId(now);
  if (!isPathComponent(runId)) return { ok: false, error: `--run-id must be a single path component: ${runId}`, code: 2 };
  const runDb = join(root, o.repo, runId, "state.db");
  let db: Database;
  try {
    db = createRunDb(runDb);
  } catch (err) {
    return { ok: false, error: `run DB creation failed: ${String(err)}`, code: 1 };
  }
  try {
    const provenance = packProvenance(o.packDirs ?? []);
    const packCommits = composePackCommits(provenance, o.mattstackSha, o.packSha);
    const packDirty = o.mattstackDirty ? 1 : provenance.dirty;
    try {
      db.run(
        "INSERT INTO runs (id, repo, work_type, pipeline, status, spawned_by, started_at, pack_commits, pack_dirty) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
        [runId, o.repo, o.workType, o.pipeline, o.spawnedBy ?? null, now, packCommits, packDirty],
      );
    } catch {
      return { ok: false, error: `run id already exists: ${runId}`, code: 1 };
    }
    if (o.ticket) {
      db.run("INSERT OR REPLACE INTO fields (run_id, key, value, produced_by, at) VALUES (?, 'ticket', ?, 'work', ?)", [runId, o.ticket, now]);
    }
    recordIdentity(db, o.env ?? process.env, now);
    return { ok: true, runId, runDb };
  } catch (err) {
    return { ok: false, error: `sqlite write failed: ${String(err)}`, code: 1 };
  } finally {
    db.close();
  }
}

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
