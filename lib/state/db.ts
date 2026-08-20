/**
 * lib/state/db.ts — state.db: one SQLite state store for rt (RT-48).
 *
 * Replaces six full-file JSON caches (~/.mattstack/rt/*.json) with a single
 * WAL-mode SQLite database at rtDir()/state.db, shared by the CLI and the
 * daemon. See docs/superpowers/specs/2026-08-20-rt-statedb.md — this module
 * implements "The database" and "Schema versioning"; store modules (Tasks
 * 2, 4, 5, 6, 7) implement "Store-by-store" on top of it.
 *
 * NO MODULE-LOAD DB ACCESS, EVER. Every export below is a function; nothing
 * at this module's top level touches disk. `getStateDb()` is a lazy
 * singleton opened on first call — a CLI command that never touches state
 * must never create, open, or migrate the db (spec "The database", and the
 * no-module-load-access rule it calls out by name).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import { rtDir } from "../rt-paths.ts";

export type DbFlavor = "cli" | "daemon";

/** PRAGMA user_version target for the schema below ("Tables (v1)"). */
export const SCHEMA_VERSION = 1;

// busy_timeout is per-process, not per-store (spec "The database"): a CLI
// command may block briefly; the daemon's event loop must never block long,
// so its writers warn-and-defer on SQLITE_BUSY instead (that policy lives in
// the daemon store modules, not here — this module only sets the pragma).
const BUSY_TIMEOUT_MS: Record<DbFlavor, number> = {
  cli: 5000,
  daemon: 250,
};

/**
 * Legacy-JSON import registration seam. Tasks 2, 4, 5, 6, 7 each append one
 * entry here (for branch-cache, project-mrs, discussions, notifier state +
 * queue, events-cursors) — db.ts never needs per-store knowledge of shape.
 *
 * `import` runs INSIDE the v0->v1 migration's BEGIN IMMEDIATE transaction,
 * once, with the legacy file's parsed JSON. It must be synchronous
 * (bun:sqlite transactions are sync-only — see spec "The database").
 */
export interface LegacyImport {
  /** Legacy JSON filename, resolved relative to the state.db's directory. */
  file: string;
  /** Applies one parsed legacy payload to rows in `db`. */
  import: (db: Database, json: unknown) => void;
}

export const LEGACY_IMPORTS: LegacyImport[] = [];

// Copied verbatim from the spec's "Tables (v1)" section — do not hand-edit
// without updating docs/superpowers/specs/2026-08-20-rt-statedb.md first.
const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS branch_cache (
  branch     TEXT PRIMARY KEY,           -- BARE branch name: the cache's semantic key TODAY, kept
  repo       TEXT,                       -- attribute, nullable (CacheEntry.repoName?, optional today)
  ticket     TEXT,                       -- JSON (LinearTicket | null)
  linear_id  TEXT NOT NULL DEFAULT '',
  mr         TEXT,                       -- JSON (MRInfo | null)
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_mrs (
  repo       TEXT NOT NULL,
  iid        INTEGER NOT NULL,
  pr         TEXT NOT NULL,              -- JSON (glance PullRequest)
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo, iid)
);
CREATE TABLE IF NOT EXISTS project_mrs_meta (
  repo            TEXT PRIMARY KEY,
  list_synced_at  INTEGER NOT NULL DEFAULT 0,
  delta_synced_at INTEGER,
  source          TEXT NOT NULL DEFAULT 'poll',
  project_path    TEXT NOT NULL DEFAULT '',
  scope           TEXT                   -- JSON ({authors, windowDays} | null)
);
CREATE TABLE IF NOT EXISTS project_mr_demands (
  repo         TEXT NOT NULL,
  client       TEXT NOT NULL,
  authors      TEXT NOT NULL,            -- JSON string[]
  declared_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (repo, client)
);

CREATE TABLE IF NOT EXISTS discussions (
  repo        TEXT NOT NULL,
  iid         INTEGER NOT NULL,
  discussions TEXT NOT NULL,             -- JSON (Discussion[])
  fetched_at  INTEGER NOT NULL,
  PRIMARY KEY (repo, iid)
);

CREATE TABLE IF NOT EXISTS notify_queue (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,  -- FIFO order
  event_id TEXT NOT NULL,                      -- NotificationEvent.id — pushToTray removes by this (notifier.ts:243-246)
  event    TEXT NOT NULL                       -- JSON (NotificationEvent)
);
CREATE INDEX IF NOT EXISTS idx_notify_queue_event_id ON notify_queue(event_id);

CREATE TABLE IF NOT EXISTS kv (
  ns         TEXT NOT NULL,
  k          TEXT NOT NULL,
  v          TEXT NOT NULL,              -- JSON
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, k)
);
`;

/** bun:sqlite error codes that mean "the file on disk is not a usable db". */
function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB";
}

/**
 * Retries a statement on SQLITE_BUSY with a short sleep, bounded by
 * `budgetMs`. `busy_timeout` already covers ordinary lock waits (e.g.
 * BEGIN IMMEDIATE), but converting a fresh file to WAL journal mode takes a
 * brief exclusive lock through a path that does not reliably honor it —
 * observed empirically as an immediate SQLITE_BUSY, not a busy-timeout
 * wait, when two processes race to open the same brand-new db file. This
 * gives that one-time conversion the same wait budget the flavor already
 * promises everywhere else.
 */
function execRetryingBusy(db: Database, sql: string, budgetMs: number): void {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      db.exec(sql);
      return;
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== "SQLITE_BUSY" || Date.now() >= deadline) throw err;
      Bun.sleepSync(10);
    }
  }
}

/**
 * PRAGMA order matters (spec "The database"): busy_timeout FIRST so the WAL
 * conversion itself respects it, THEN journal_mode, THEN synchronous.
 */
function applyPragmas(db: Database, flavor: DbFlavor): void {
  const budgetMs = BUSY_TIMEOUT_MS[flavor];
  db.exec(`PRAGMA busy_timeout = ${budgetMs};`);
  execRetryingBusy(db, "PRAGMA journal_mode = WAL;", budgetMs);
  db.exec("PRAGMA synchronous = NORMAL;");
}

/**
 * Renames a corrupt db file out of the way and warns loudly ("Corruption
 * escape", distinct from a failing migration — spec "The database"). WAL
 * sidecars are best-effort cleaned since they are meaningless without the
 * main file; their loss is not itself corruption.
 */
function quarantine(path: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinedPath = `${path}.corrupt-${stamp}`;
  console.warn(`rt: state db ${path} could not be opened (corrupt), quarantining to ${quarantinedPath} and recreating empty`);
  renameSync(path, quarantinedPath);
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try {
      renameSync(sidecar, `${sidecar}.corrupt-${stamp}`);
    } catch {
      // sidecar absent — fine, WAL mode doesn't always leave one
    }
  }
}

/**
 * Runs each registered legacy importer whose source file exists, inside the
 * caller's transaction. Returns the list of source paths that were consumed
 * (successfully imported OR corrupt-and-skipped) — both cases still rename
 * per spec "Migration & contention" ("corrupt = warn + skip"; brief: "warn +
 * skip + still rename"). Renaming itself happens AFTER COMMIT (the caller
 * does it), since a filesystem rename cannot participate in the sqlite
 * transaction.
 */
function importLegacyStores(db: Database, dir: string): string[] {
  const consumed: string[] = [];
  for (const entry of LEGACY_IMPORTS) {
    const path = join(dir, entry.file);
    if (!existsSync(path)) continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.warn(`rt: legacy state file ${path} is corrupt JSON, skipping import: ${(err as Error).message}`);
      consumed.push(path);
      continue;
    }
    entry.import(db, json);
    consumed.push(path);
  }
  return consumed;
}

/**
 * The race-proof migration runner (spec "Schema versioning"): BEGIN
 * IMMEDIATE takes the write lock up front, user_version is RE-READ inside
 * the transaction, and all DDL is IF NOT EXISTS. Two processes racing at
 * v0: the loser blocks on IMMEDIATE (busy_timeout), then sees v1 inside its
 * own transaction and applies nothing. A throwing migration rolls back and
 * propagates — no swallow.
 */
function runMigrations(db: Database, dir: string): void {
  db.exec("BEGIN IMMEDIATE;");
  let toRename: string[] = [];
  try {
    const { user_version } = db.query("PRAGMA user_version;").get() as { user_version: number };
    if (user_version < SCHEMA_VERSION) {
      db.exec(V1_SCHEMA);
      toRename = importLegacyStores(db, dir);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // best-effort — the original error is what matters
    }
    throw err;
  }
  for (const path of toRename) {
    try {
      renameSync(path, `${path}.migrated`);
    } catch (err) {
      console.warn(`rt: imported legacy state file ${path} but could not rename it to .migrated: ${(err as Error).message}`);
    }
  }
}

/**
 * Opens (creating if absent), pragma-configures, and migrates a state db at
 * an explicit path. This is the seam tests and store constructors use
 * directly (spec: "stores constructed via openStateDb(tempPath)").
 * `getStateDb()` is the production lazy singleton built on top of this.
 */
export function openStateDb(path: string, flavor: DbFlavor = "cli"): Database {
  mkdirSync(dirname(path), { recursive: true });

  let db: Database;
  try {
    db = new Database(path, { create: true });
    applyPragmas(db, flavor);
    // Pragmas alone don't always force sqlite to validate the file header;
    // touch it now so a corrupt file surfaces here, not mid-migration.
    db.query("PRAGMA user_version;").get();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    quarantine(path);
    db = new Database(path, { create: true });
    applyPragmas(db, flavor);
  }

  runMigrations(db, dirname(path));
  return db;
}

let singleton: Database | null = null;

/**
 * The lazy production singleton: one connection per process, held for the
 * process lifetime (spec "The database"). Never call this at module scope.
 */
export function getStateDb(flavor: DbFlavor = "cli"): Database {
  if (!singleton) {
    singleton = openStateDb(join(rtDir(), "state.db"), flavor);
  }
  return singleton;
}

/** Closes and clears the lazy singleton, if one is open. Tests use this to reset state between cases. */
export function closeStateDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
