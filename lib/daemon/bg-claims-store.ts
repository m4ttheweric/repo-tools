/**
 * Background claims: one row per owner holding a bg process (herd/runner/
 * agent). Its own SQLite file, same shape as herd-store.ts (single table, no
 * versioned migrations) so it never takes part in state.db's SCHEMA_VERSION
 * claim. The pane column stores the caller-provided string verbatim; this
 * store never parses it (downstream tasks always pass a bg: ref).
 */
import { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import type { Logger } from "pino";
import { isCorruptionError } from "../state/db.ts";

export interface BgClaimsStore {
  claim(owner: string, pane?: string): void;
  release(owner: string): boolean;
  releaseByPane(pane: string): string[];
  list(): Array<{ owner: string; pane: string | null; createdAt: number }>;
  close_(): void;
}

interface ClaimColumns { owner: string; pane: string | null; created_at: number }

function quarantine(path: string, log: Logger): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  log.warn({ path }, "bg claims db could not be opened (corrupt), quarantining and recreating empty");
  renameSync(path, `${path}.corrupt-${stamp}`);
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try { renameSync(sidecar, `${sidecar}.corrupt-${stamp}`); } catch { /* sidecar absent */ }
  }
}

export function createBgClaimsStore(opts: { dbPath: string; log: Logger }): BgClaimsStore {
  const log = opts.log.child({ module: "bg-claims" });
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  const openDb = () => {
    const db = new Database(opts.dbPath, { create: true });
    db.exec("PRAGMA busy_timeout = 250;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    return db;
  };
  let db: Database;
  try {
    db = openDb();
    db.query("PRAGMA user_version").get();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    quarantine(opts.dbPath, log);
    db = openDb();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      owner      TEXT PRIMARY KEY,
      pane       TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  const upsert = db.prepare("INSERT INTO claims (owner, pane, created_at) VALUES (?, ?, ?) ON CONFLICT(owner) DO UPDATE SET pane = excluded.pane");
  const deleteByOwner = db.prepare("DELETE FROM claims WHERE owner = ?");
  const ownersByPane = db.prepare("SELECT owner FROM claims WHERE pane = ?");
  const deleteByPane = db.prepare("DELETE FROM claims WHERE pane = ?");
  const listStmt = db.prepare("SELECT * FROM claims ORDER BY created_at");

  return {
    claim(owner, pane) {
      upsert.run(owner, pane ?? null, Date.now());
    },
    release(owner) {
      const result = deleteByOwner.run(owner);
      return result.changes > 0;
    },
    releaseByPane(pane) {
      const owners = (ownersByPane.all(pane) as { owner: string }[]).map((r) => r.owner);
      deleteByPane.run(pane);
      return owners;
    },
    list() {
      return (listStmt.all() as ClaimColumns[]).map((r) => ({ owner: r.owner, pane: r.pane, createdAt: r.created_at }));
    },
    close_() { db.close(); },
  };
}
