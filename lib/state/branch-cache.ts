/**
 * lib/state/branch-cache.ts — the single-owner branch-cache store (RT-48).
 *
 * Replaces the two separately-declared branch-cache implementations
 * (`lib/daemon/branch-cache.ts` and the disk-cache half of `lib/enrich.ts`)
 * with one module, one `CacheEntry` type, and one row-backed store over the
 * `branch_cache` table in state.db. See
 * docs/superpowers/specs/2026-08-20-rt-statedb.md — "Tables (v1)"
 * (`branch_cache`), "Store-by-store" item 1, and "New: branch-cache GC".
 *
 * `branch_cache` keeps the bare BRANCH NAME as its primary key (not
 * `(repo, branch)`): the bare branch is the cache's semantic key today, and
 * `enrichBranches`' `fetchAndCache` path has no repoName to offer. `repo`
 * stays a nullable attribute, exactly as `CacheEntry.repoName?` is optional
 * today. Consumer rewiring (daemon, enrich.ts, handlers) is Task 3 — this
 * module only produces the store; nothing outside lib/state/ imports it yet.
 */

import { Database } from "bun:sqlite";
import type { LinearTicket } from "../linear.ts";
import type { MRInfo } from "../enrich.ts";
import { getStateDb, LEGACY_IMPORTS } from "./db.ts";

export interface CacheEntry {
  ticket: LinearTicket | null;
  linearId: string;
  mr: MRInfo | null;
  fetchedAt: number;
  repoName?: string;
}

export interface BranchCacheStore {
  /** The live map — ctx.cache-compatible. Same object identity across reload(). */
  entries: Record<string, CacheEntry>;
  /** Map + row upsert, one call. Upserts by bare branch (PRIMARY KEY). */
  put(branch: string, entry: CacheEntry): void;
  /** Map + row delete, one call. */
  delete(branch: string): void;
  /** Rebuilds `entries` in place from the db (replaces loadCache-from-file). */
  reload(): void;
  /**
   * Prunes rows (and the in-memory map) older than `maxAgeMs`: a repo's rows
   * only when that repo's name is in `succeededRepos` (spec "New:
   * branch-cache GC" — gating is on success, not on failure exemption);
   * NULL-repo rows are prunable by age alone (unattributable, re-enrich on
   * demand).
   */
  gc(succeededRepos: Set<string>, maxAgeMs: number): void;
}

interface BranchCacheRow {
  branch: string;
  repo: string | null;
  ticket: string | null;
  linear_id: string;
  mr: string | null;
  fetched_at: number;
}

function rowToEntry(row: BranchCacheRow): CacheEntry {
  return {
    ticket: row.ticket !== null ? (JSON.parse(row.ticket) as LinearTicket) : null,
    linearId: row.linear_id,
    mr: row.mr !== null ? (JSON.parse(row.mr) as MRInfo) : null,
    fetchedAt: row.fetched_at,
    repoName: row.repo ?? undefined,
  };
}

const UPSERT_SQL = `
  INSERT INTO branch_cache (branch, repo, ticket, linear_id, mr, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(branch) DO UPDATE SET
    repo = excluded.repo,
    ticket = excluded.ticket,
    linear_id = excluded.linear_id,
    mr = excluded.mr,
    fetched_at = excluded.fetched_at
`;

function createStore(db: Database): BranchCacheStore {
  const entries: Record<string, CacheEntry> = {};

  function loadAll(): Record<string, CacheEntry> {
    const rows = db.query("SELECT branch, repo, ticket, linear_id, mr, fetched_at FROM branch_cache;").all() as BranchCacheRow[];
    const next: Record<string, CacheEntry> = {};
    for (const row of rows) next[row.branch] = rowToEntry(row);
    return next;
  }

  function reload(): void {
    const fresh = loadAll();
    for (const key of Object.keys(entries)) delete entries[key];
    Object.assign(entries, fresh);
  }

  function put(branch: string, entry: CacheEntry): void {
    db.query(UPSERT_SQL).run(
      branch,
      entry.repoName ?? null,
      entry.ticket !== null ? JSON.stringify(entry.ticket) : null,
      entry.linearId,
      entry.mr !== null ? JSON.stringify(entry.mr) : null,
      entry.fetchedAt,
    );
    entries[branch] = entry;
  }

  function del(branch: string): void {
    db.query("DELETE FROM branch_cache WHERE branch = ?;").run(branch);
    delete entries[branch];
  }

  function gc(succeededRepos: Set<string>, maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs;
    const rows = db.query("SELECT branch, repo, fetched_at FROM branch_cache;").all() as Pick<BranchCacheRow, "branch" | "repo" | "fetched_at">[];
    const toDelete: string[] = [];
    for (const row of rows) {
      if (row.fetched_at >= cutoff) continue;
      if (row.repo === null) {
        toDelete.push(row.branch);
      } else if (succeededRepos.has(row.repo)) {
        toDelete.push(row.branch);
      }
    }
    if (toDelete.length === 0) return;

    const deleteStmt = db.query("DELETE FROM branch_cache WHERE branch = ?;");
    const runDeletes = db.transaction((branches: string[]) => {
      for (const branch of branches) deleteStmt.run(branch);
    });
    runDeletes(toDelete);
    for (const branch of toDelete) delete entries[branch];
  }

  reload();

  return { entries, put, delete: del, reload, gc };
}

let singletonStore: BranchCacheStore | null = null;
let singletonDb: Database | null = null;

/** Process-wide singleton (spec "Store-by-store" item 1: "the store object is a process-wide singleton"). */
export function getBranchCacheStore(db?: Database): BranchCacheStore {
  const targetDb = db ?? getStateDb();
  if (singletonStore && singletonDb === targetDb) return singletonStore;
  singletonStore = createStore(targetDb);
  singletonDb = targetDb;
  return singletonStore;
}

// ─── Legacy import (branch-cache.json → branch_cache rows) ─────────────────

interface LegacyCacheEntry {
  ticket?: LinearTicket | null;
  linearId?: string;
  mr?: MRInfo | null;
  fetchedAt?: number;
  repoName?: string;
  // discussions / discussionsFetchedAt intentionally not read: legacy
  // embedded discussions are dropped at import, never written anywhere.
}

interface LegacyDiskCache {
  entries?: Record<string, LegacyCacheEntry>;
}

LEGACY_IMPORTS.push({
  file: "branch-cache.json",
  import: (db, json) => {
    const parsed = json as LegacyDiskCache | null;
    const legacyEntries = parsed?.entries ?? {};
    const stmt = db.query(UPSERT_SQL);
    for (const [branch, entry] of Object.entries(legacyEntries)) {
      if (!entry) continue;
      stmt.run(
        branch,
        entry.repoName ?? null,
        entry.ticket != null ? JSON.stringify(entry.ticket) : null,
        entry.linearId ?? "",
        entry.mr != null ? JSON.stringify(entry.mr) : null,
        entry.fetchedAt ?? 0,
      );
    }
  },
});
