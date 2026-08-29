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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { rtDir } from "../rt-paths.ts";

export type DbFlavor = "cli" | "daemon";

/** PRAGMA user_version target for the combined schema below (v1 + v2 + v3 + v4 + v6 + v7 + v8 + v9). */
export const SCHEMA_VERSION = 9;

// busy_timeout is per-process, not per-store (spec "The database"): a CLI
// command may block briefly; the daemon's event loop must never block long,
// so its writers warn-and-defer on SQLITE_BUSY instead (that policy lives in
// the daemon store modules, not here — this module only sets the pragma).
const BUSY_TIMEOUT_MS: Record<DbFlavor, number> = {
  cli: 5000,
  daemon: 250,
};

/**
 * The busy budget for the open+migrate phase, for BOTH flavors.
 *
 * The daemon's 250ms is a SERVE-TIME policy ("the daemon loop must never
 * block long"), and the spec draws that line explicitly: "the daemon
 * performs open+migrate during startup, BEFORE serving ... and if a CLI
 * process is mid-import when the daemon starts, the daemon blocks in
 * startup, not in its event loop" (spec "Migration & contention").
 *
 * Under a flavor-timeout-first open, that promised block became a throw:
 * `runMigrations()`'s BEGIN IMMEDIATE (and `execRetryingBusy`'s WAL
 * conversion) would give up after 250ms while a racing CLI held the write
 * lock through the one long transaction in the system — the ~3.4MB
 * legacy-JSON import — and daemon startup would crash instead of waiting.
 * So: startup budget for open+migrate, then the flavor's steady-state
 * busy_timeout once migration has returned.
 */
const MIGRATION_BUSY_TIMEOUT_MS = 5000;

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
  v          TEXT NOT NULL,              -- JSON: for ns='dev-mode', k='config' see the note below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, k)
);
`;

// kv row (ns='dev-mode', k='config') has an OUT-OF-TREE READER:
// rt-tray/Sources-daemon-shim/main.swift execv's into the dev daemon before
// bun exists, so it queries this table/columns directly via libsqlite3
// rather than through this module. The table name, the `ns`/`k`/`v` columns,
// and this row's `{sourcePath, bunPath}` JSON shape cannot change without
// updating that Swift file in the same commit.

// Tables (v2): only state whose access pattern needs a point query, a
// point mutation, or a bounded-retention delete gets its own table — every
// other new cache is a `kv` row (one ns per cache, one row per whole-blob
// value). `kv` alone cannot serve `endpoint_claims` or `run_history` without
// forcing every point mutation to decode-mutate-reencode a whole array.
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS endpoint_claims (
  repo     TEXT NOT NULL,
  worktree TEXT NOT NULL,
  role     TEXT NOT NULL,
  port     INTEGER NOT NULL,
  pid      INTEGER,
  ts       TEXT NOT NULL,                -- ISO
  PRIMARY KEY (repo, worktree, role)
);

CREATE TABLE IF NOT EXISTS run_history (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,  -- insertion order within a repo
  repo     TEXT NOT NULL,
  ts       TEXT NOT NULL,                -- ISO
  cmd      TEXT NOT NULL,
  cwd      TEXT NOT NULL,
  worktree TEXT NOT NULL,
  branch   TEXT NOT NULL,
  pkg      TEXT NOT NULL,
  script   TEXT NOT NULL,
  exit     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_run_history_repo_id ON run_history(repo, id);
`;

// Tables (v3): rooms/members/messages for `rt chat` (lib/state/chat-store.ts
// is the only module that touches them). `reply_to` ships unused — one
// nullable column now versus a migration later.
const V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_rooms (
  name        TEXT PRIMARY KEY,
  purpose     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room       TEXT NOT NULL,
  handle     TEXT NOT NULL,
  body       TEXT NOT NULL,
  mentions   TEXT,
  reply_to   INTEGER,
  posted_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_room_id ON chat_messages(room, id);
-- (room, posted_at): pruneMessages' age cutoff filters on posted_at per
-- room, and listRooms' SELECT_ROOM_LAST_POSTED_SQL (MAX(posted_at) WHERE
-- room = ?) turns into an index-only scan instead of a per-room table scan.
CREATE INDEX IF NOT EXISTS chat_messages_room_posted ON chat_messages(room, posted_at);
CREATE TABLE IF NOT EXISTS chat_members (
  room          TEXT NOT NULL,
  handle        TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  last_read_id  INTEGER NOT NULL DEFAULT 0,
  wake_on       TEXT NOT NULL DEFAULT 'mention',
  last_seen_at  INTEGER,                 -- vestigial (delivery-v2 hard cutover): no code reads or writes this column; kept for schema stability, never migrated away
  armed_at      INTEGER,                 -- vestigial (delivery-v2 hard cutover): no code reads or writes this column; kept for schema stability, never migrated away
  cwd           TEXT,
  pane          TEXT,
  PRIMARY KEY (room, handle)
);
`;

// Tables (v4): sign-in presence, DM participant pairs, and a room's
// join-time wake_on default (lib/state/chat-store.ts owns these too). The
// inline column comments below are the schema's only documentation — keep
// them in sync with what the code actually does with each column.
const V4_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_presence (
  session_id     TEXT PRIMARY KEY,
  handle         TEXT NOT NULL UNIQUE,   -- the assigned display name, suffix included
  base_handle    TEXT NOT NULL,          -- what resolution produced before suffixing
  cwd            TEXT,
  repo           TEXT,                   -- repoLabel of the cwd's identity, for display
  branch         TEXT,
  pane           TEXT,                   -- HERDR_PANE_ID when known
  status_text    TEXT,                   -- the away message; NULL when back
  signed_in_at   INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,       -- set at sign-in; prune's staleness leg reads it
  tail_seen_at   INTEGER,                -- vestigial (delivery-v2 hard cutover): no code reads or writes this column; kept for schema stability, never migrated away
  armed_at       INTEGER,                -- vestigial (delivery-v2 hard cutover): no code reads or writes this column; kept for schema stability, never migrated away
  signed_out_at  INTEGER                 -- NULL while signed in
);
CREATE INDEX IF NOT EXISTS chat_presence_handle ON chat_presence(handle);

CREATE TABLE IF NOT EXISTS chat_room_defaults (
  room     TEXT PRIMARY KEY,              -- rows exist only for rooms stamped at creation
  wake_on  TEXT NOT NULL                  -- mention | all | none
);

CREATE TABLE IF NOT EXISTS chat_dms (
  room        TEXT PRIMARY KEY REFERENCES chat_rooms(name),   -- documentation only: foreign_keys is off in applyPragmas; deletion is explicit
  a           TEXT NOT NULL,             -- participants, sorted; either may be the human handle
  b           TEXT NOT NULL CHECK (a <> b),
  created_at  INTEGER NOT NULL,
  UNIQUE (a, b)
);
`;

// Tables (v6): CODEOWNERS section tags on project-mrs rows (RT board
// codeowner tabs). `project_mr_sections` is a separate table, not a column
// on `project_mrs`, so `setSectionTags`'s per-iid clear (empty array) is a
// plain DELETE rather than a NULL-vs-empty-string ambiguity on that row.
const V6_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_mr_sections (
  repo     TEXT NOT NULL,
  iid      INTEGER NOT NULL,
  sections TEXT NOT NULL,               -- JSON string[]
  PRIMARY KEY (repo, iid)
);
`;

// Tables (v7): agent handoff records for `rt agent`
// (lib/state/agents-store.ts is the only module that touches them).
// Additive only: never put ALTER TABLE or non-IF-NOT-EXISTS DDL in a
// V*_SCHEMA block... runMigrations replays the full concat on every bump.
const V7_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  repo            TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  provider        TEXT NOT NULL,
  surface         TEXT NOT NULL,
  session_id      TEXT NOT NULL UNIQUE,
  model           TEXT,
  effort          TEXT,
  account         TEXT,
  label           TEXT,
  caller          TEXT,
  pane_id         TEXT,
  tab_id          TEXT,
  workspace_id    TEXT,
  extra_args      TEXT,
  exit_code       INTEGER,
  result_path     TEXT,
  created_at      INTEGER NOT NULL,
  last_resumed_at INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS agents_repo_created ON agents(repo, created_at);
-- created_at alone: SELECT_ALL_SQL orders the whole table by created_at DESC
-- with no repo filter, which agents_repo_created (repo, created_at) cannot
-- serve as an index-only scan.
CREATE INDEX IF NOT EXISTS agents_created ON agents(created_at);
`;

/**
 * Every schema block, in version order. `runMigrations` execs
 * `SCHEMAS.join("")` unconditionally on EVERY open (R015/R056): every
 * statement here is `IF NOT EXISTS`, so replaying against a db that already
 * has the shape is a no-op, and a db missing a table (dropped by hand, by a
 * bug, or by a partial write) self-heals instead of staying broken forever.
 * A future schema block joins this array; leaving one out is caught by the
 * dynamic table-presence test in db-schema-convergence.test.ts.
 */
const SCHEMAS = [V1_SCHEMA, V2_SCHEMA, V3_SCHEMA, V4_SCHEMA, V6_SCHEMA, V7_SCHEMA];

/** project_mr_demands.sections (v6): SQLite's ALTER TABLE ADD COLUMN has no
    IF NOT EXISTS, so unlike every statement in the V*_SCHEMA strings above it
    cannot simply replay -- SCHEMAS.join("") execs against every db on every
    open, and an unconditional ALTER would throw "duplicate column", rolling
    back the migration and wedging every later openStateDb call. Run it here
    instead, inside the same migration transaction, gated on the column's
    actual absence. Any future ALTER-added column follows this same
    conditional-exec pattern, never the DDL strings. */
function addSectionsColumnIfMissing(db: Database): void {
  const columns = db.query("PRAGMA table_info(project_mr_demands);").all() as { name: string }[];
  if (columns.some((c) => c.name === "sections")) return;
  db.exec("ALTER TABLE project_mr_demands ADD COLUMN sections TEXT;");
}

/** chat_rooms.archived_at (v8): the same conditional-exec rule as `sections`
    above, because the DDL string replays on every bump. */
function addArchivedAtColumnIfMissing(db: Database): void {
  const columns = db.query("PRAGMA table_info(chat_rooms);").all() as { name: string }[];
  if (columns.some((c) => c.name === "archived_at")) return;
  db.exec("ALTER TABLE chat_rooms ADD COLUMN archived_at INTEGER;");
}

/** agents.handle (v9): the chat handle reserved at agent:start. Same
    conditional-exec rule as `sections` and `archived_at` above. */
function addHandleColumnIfMissing(db: Database): void {
  const columns = db.query("PRAGMA table_info(agents);").all() as { name: string }[];
  if (columns.some((c) => c.name === "handle")) return;
  db.exec("ALTER TABLE agents ADD COLUMN handle TEXT;");
}

/**
 * endpoint_claims.start_time (S068): the claiming pid's start-time, so a
 * recycled pid across a reboot reads as dead rather than pinning a port
 * forever. Called unconditionally from `openStateDb`, outside
 * `runMigrations`'s BEGIN IMMEDIATE transaction, unlike the three
 * `addXColumnIfMissing` helpers above: those run inside the transaction,
 * where a losing racer's duplicate-column error rolls back the whole
 * migration; this one needs its own catch-and-recheck (below) to tolerate
 * that same race outside a transaction's protection. No SCHEMA_VERSION
 * bump: this column ships out-of-band of the versioned schema, like
 * `sections`, `archived_at`, and `handle` above.
 */
export function ensureEndpointClaimsStartTimeColumn(db: Database): void {
  const columns = db.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[];
  if (columns.some((c) => c.name === "start_time")) return;
  try {
    db.exec("ALTER TABLE endpoint_claims ADD COLUMN start_time TEXT;");
  } catch (err) {
    // This runs outside runMigrations' BEGIN IMMEDIATE transaction (see the
    // doc comment above), so a daemon and a CLI process opening the same
    // fresh file can both read the column missing and both attempt the
    // ALTER. The loser's failure only matters if the column still isn't there.
    const after = db.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[];
    if (!after.some((c) => c.name === "start_time")) throw err;
  }
}

/** bun:sqlite error codes that mean "the file on disk is not a usable db". */
export function isCorruptionError(err: unknown): boolean {
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
 *
 * `budgetMs` is the startup budget, not the flavor's steady-state timeout —
 * see MIGRATION_BUSY_TIMEOUT_MS; `openStateDb` narrows it to the flavor's
 * value after migration.
 */
function applyPragmas(db: Database, budgetMs: number): void {
  db.exec(`PRAGMA busy_timeout = ${budgetMs};`);
  execRetryingBusy(db, "PRAGMA journal_mode = WAL;", budgetMs);
  db.exec("PRAGMA synchronous = NORMAL;");
}

/**
 * Every reader of this db (CLI, daemon, tray, VS Code extension host) runs
 * as the same uid, so group/other read buys nothing and, once a credential
 * row lands here, only widens exposure. Applied on EVERY open, not just
 * creation, so a file left at a looser mode — from before this ran, or from
 * any other writer — gets tightened rather than trusted. Operates only on
 * the exact path this call opened, plus its WAL sidecars (same string,
 * `-wal`/`-shm` suffixed) — never a directory scan: other files also named
 * `state.db` exist elsewhere on disk with an unrelated schema and must
 * never be touched by this call.
 */
function tightenFileMode(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(target, 0o600);
    } catch {
      // sidecar absent — fine, WAL mode doesn't always leave one
    }
  }
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
 * (successfully imported OR corrupt/throwing-and-skipped): all three cases
 * still rename per spec "Migration & contention" ("corrupt = warn + skip";
 * brief: "warn + skip + still rename"). Renaming itself happens AFTER COMMIT
 * (the caller does it), since a filesystem rename cannot participate in the
 * sqlite transaction.
 *
 * Each importer's `import(db, json)` runs inside its own SAVEPOINT, nested
 * inside the caller's outer BEGIN IMMEDIATE. A throwing importer (e.g. two
 * legacy keys that normalize to the same primary key, tripping a UNIQUE
 * constraint) previously rolled back the WHOLE v0->v1 migration: user_version
 * stayed 0, so every later openStateDb call replayed the identical throw
 * forever with no self-heal. The savepoint confines that rollback to the one
 * importer's own writes, so the schema DDL and every OTHER importer still
 * commit and the db reaches SCHEMA_VERSION. This is deliberately narrower
 * than the outer transaction's own error handling: schema/DDL failures are
 * not wrapped here and still abort the whole migration loudly.
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
    db.exec("SAVEPOINT legacy_import;");
    try {
      entry.import(db, json);
      db.exec("RELEASE legacy_import;");
    } catch (err) {
      db.exec("ROLLBACK TO legacy_import; RELEASE legacy_import;");
      console.warn(`rt: legacy import failed for ${path}, skipping (file will still be renamed): ${(err as Error).message}`);
    }
    consumed.push(path);
  }
  return consumed;
}

/**
 * The race-proof migration runner (spec "Schema versioning"): BEGIN
 * IMMEDIATE takes the write lock up front, and every statement in
 * `SCHEMAS.join("")` plus the three guarded column helpers below is IF NOT
 * EXISTS or table_info-guarded, so the whole block runs UNCONDITIONALLY on
 * every open, not only while `user_version < SCHEMA_VERSION` (R015/R056): a
 * db already at SCHEMA_VERSION but missing a table or column self-heals on
 * its next open instead of staying broken forever. `user_version` is read
 * once to gate ONLY the legacy-JSON import, which is not idempotent (see
 * importLegacyStores' own comment), and is unconditionally re-stamped to
 * SCHEMA_VERSION for compatibility with older builds' version checks. Two
 * processes racing at v0: the loser blocks on IMMEDIATE (busy_timeout), then
 * re-reads v1 inside its own transaction and skips the import. A throwing
 * migration rolls back and propagates, no swallow.
 */
function runMigrations(db: Database, dir: string): void {
  db.exec("BEGIN IMMEDIATE;");
  let toRename: string[] = [];
  try {
    const { user_version } = db.query("PRAGMA user_version;").get() as { user_version: number };
    db.exec(SCHEMAS.join(""));
    addSectionsColumnIfMissing(db);
    addArchivedAtColumnIfMissing(db);
    addHandleColumnIfMissing(db);
    // Legacy-JSON import is single-shot and only correct from a true
    // v0 (never-migrated) database: branch-cache's UPSERT would silently
    // overwrite current rows with stale ones, and project-mrs-store's
    // plain INSERT would hit its UNIQUE constraint, roll back this whole
    // migration, and make every later openStateDb call throw.
    if (user_version === 0) {
      toRename = importLegacyStores(db, dir);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
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
    applyPragmas(db, MIGRATION_BUSY_TIMEOUT_MS);
    // Pragmas alone don't always force sqlite to validate the file header;
    // touch it now so a corrupt file surfaces here, not mid-migration.
    db.query("PRAGMA user_version;").get();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    quarantine(path);
    db = new Database(path, { create: true });
    applyPragmas(db, MIGRATION_BUSY_TIMEOUT_MS);
  }

  runMigrations(db, dirname(path));
  // Outside runMigrations' transaction: see ensureEndpointClaimsStartTimeColumn's
  // own comment for why.
  ensureEndpointClaimsStartTimeColumn(db);
  // Migration is done: drop from the startup budget to the flavor's
  // steady-state serve-time policy (daemon = 250ms warn-and-defer).
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS[flavor]};`);
  tightenFileMode(path);
  return db;
}

/** Version-guarded open for the CLI daemon-down fallback.
    Refuses a db STRICTLY newer than this build so a short-lived CLI never
    stamps a schema another build owns; equal-or-behind opens and migrates
    normally (data-preserving, IF NOT EXISTS). A missing file is created. */
export function openStateDbGuarded(path: string): Database {
  if (existsSync(path)) {
    const probe = new Database(path, { readonly: true });
    let userVersion: number;
    try {
      userVersion = (probe.query("PRAGMA user_version;").get() as { user_version: number }).user_version;
    } finally {
      probe.close();
    }
    if (userVersion > SCHEMA_VERSION) {
      throw new Error(`state.db is newer than this rt build (v${userVersion} > v${SCHEMA_VERSION}); start the matching daemon`);
    }
  }
  return openStateDb(path, "cli");
}

/**
 * Writes a standalone, fully-vacuumed copy of `db` to `path` via `VACUUM
 * INTO` (R055): unlike a raw file copy, this is safe against a concurrent
 * writer mid-transaction and against WAL sidecars, since sqlite produces the
 * destination from a read-consistent snapshot in one statement.
 */
export function backupTo(db: Database, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  db.query("VACUUM INTO ?").run(path);
}

/**
 * `PRAGMA quick_check` wrapper: `[]` when the db reports "ok", otherwise the
 * problem lines. A quick_check severe enough to throw outright (observed as
 * SQLITE_CORRUPT on some corruption shapes, rather than a diagnostic row) is
 * folded into the same nonempty-list contract instead of propagating.
 */
export function quickCheck(db: Database): string[] {
  try {
    const rows = db.query("PRAGMA quick_check;").all() as { quick_check: string }[];
    const lines = rows.map((r) => r.quick_check);
    return lines.length === 1 && lines[0] === "ok" ? [] : lines;
  } catch (err) {
    return [(err as Error).message];
  }
}

/** ~/.mattstack/rt/backups: stamped state.db copies from `rt state backup` and the daily sweep. */
export function stateBackupsDir(): string {
  return join(dirname(stateDbPath()), "backups");
}

const STATE_BACKUP_PREFIX = "state-";
const STATE_BACKUP_SUFFIX = ".db";
const STATE_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A fresh stamped path under stateBackupsDir(); the stamp format matches quarantine()'s. */
export function stampedBackupPath(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(stateBackupsDir(), `${STATE_BACKUP_PREFIX}${stamp}${STATE_BACKUP_SUFFIX}`);
}

/** Stamped backup filenames under stateBackupsDir(), newest first. `[]` when the dir doesn't exist yet. */
export function listStateBackups(): string[] {
  const dir = stateBackupsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(STATE_BACKUP_PREFIX) && name.endsWith(STATE_BACKUP_SUFFIX))
    .sort()
    .reverse();
}

/** Removes stamped backups older than the retention window; returns the removed filenames. */
export function pruneStateBackups(now: number = Date.now()): { removed: string[] } {
  const dir = stateBackupsDir();
  const removed: string[] = [];
  for (const name of listStateBackups()) {
    const iso = name.slice(STATE_BACKUP_PREFIX.length, -STATE_BACKUP_SUFFIX.length)
      .replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
    const at = Date.parse(iso);
    if (Number.isNaN(at) || now - at <= STATE_BACKUP_RETENTION_MS) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      // a concurrent sweep or manual cleanup already removed it
    }
  }
  return { removed };
}

let singleton: Database | null = null;
let singletonPath: string | null = null;

/** Resolved at call time, never cached: the suite swaps `process.env.HOME` between cases, and a memoized path would outlive the HOME it was derived from. */
export function stateDbPath(): string {
  return join(rtDir(), "state.db");
}

/**
 * The lazy production singleton: one connection per process, held for the
 * process lifetime (spec "The database") — true in production, where
 * `rtDir()` never changes mid-process. Re-derived on every call (not cached
 * at first open) so a test suite that swaps `process.env.HOME` between
 * cases — the standard per-test isolation pattern elsewhere in this repo —
 * transparently gets a fresh connection at the new path instead of silently
 * reusing a handle whose underlying file a DIFFERENT test's cleanup may have
 * since deleted (SQLITE_IOERR_VNODE). Never call this at module scope.
 */
export function getStateDb(flavor: DbFlavor = "cli"): Database {
  const path = stateDbPath();
  if (singleton && singletonPath === path) {
    // A caller asking for a stronger (shorter) contention policy than the
    // singleton currently holds must not silently inherit whatever flavor
    // opened it first (e.g. a "cli" 5000ms opener beating the daemon's own
    // "daemon" 250ms open); re-tighten in place rather than reopening.
    const want = BUSY_TIMEOUT_MS[flavor];
    const have = Number((singleton.query("PRAGMA busy_timeout").get() as { timeout?: number } | null)?.timeout ?? 0);
    if (want < have) singleton.exec(`PRAGMA busy_timeout = ${want};`);
    return singleton;
  }
  singleton?.close();
  singleton = openStateDb(path, flavor);
  singletonPath = path;
  return singleton;
}

/** Closes and clears the lazy singleton, if one is open. Tests use this to reset state between cases. */
export function closeStateDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
    singletonPath = null;
  }
}
