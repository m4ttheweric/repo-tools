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
 *
 * SQLITE_BUSY policy: every row write here goes through `persistOrWarn`
 * (lib/state/busy.ts), for BOTH connection flavors, deliberately. The store
 * carries no flavor, and it does not need one:
 *   - the daemon flavor (250ms busy_timeout) is what the wrapper exists for,
 *     and this store's in-memory map is the authoritative read model (spec
 *     "In-memory ownership") — a deferred row re-converges on the next
 *     write, at worst costing one re-enrichment;
 *   - the CLI flavor's 5000ms budget makes a BUSY here already pathological,
 *     and when it does happen, aborting an interactive command over a CACHE
 *     row is strictly worse than the same defer.
 * `notify_queue` is the one documented exception to warn-and-defer (bounded
 * retry, then an error) and lives in notifier-store.ts, not here.
 */

import { Database } from "bun:sqlite";
import type { LinearTicket } from "../linear.ts";
import type { MRInfo } from "../enrich.ts";
import { getStateDb, LEGACY_IMPORTS } from "./db.ts";
import { persistOrWarn } from "./busy.ts";

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
    // The map update sits OUTSIDE the wrapper on purpose: it is this cycle's
    // freshly enriched truth and the thing handlers serve, so it must land
    // even when the row defers. (gc/delete keep the two together instead —
    // see below.)
    persistOrWarn("branch-cache", () => {
      db.query(UPSERT_SQL).run(
        branch,
        entry.repoName ?? null,
        entry.ticket !== null ? JSON.stringify(entry.ticket) : null,
        entry.linearId,
        entry.mr !== null ? JSON.stringify(entry.mr) : null,
        entry.fetchedAt,
      );
    }, { op: "put", branch });
    entries[branch] = entry;
  }

  function del(branch: string): void {
    // Row and map evict together: a map-only eviction would be undone by the
    // next reload(), so a deferred delete simply retries next cycle.
    persistOrWarn("branch-cache", () => {
      db.query("DELETE FROM branch_cache WHERE branch = ?;").run(branch);
      delete entries[branch];
    }, { op: "delete", branch });
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

    // The DELETE re-states the staleness predicate the SELECT above chose on.
    // Without it, a CLI `rt run` enrichment that upserts one of these branches
    // in the window between the two statements loses its brand-new row to a
    // decision made before it existed. With it, a row that moved forward
    // simply reports 0 changes and survives.
    const deleteStmt = db.query("DELETE FROM branch_cache WHERE branch = ? AND fetched_at < ?;");
    const deleted: string[] = [];
    const runDeletes = db.transaction((branches: string[]) => {
      deleted.length = 0;
      for (const branch of branches) {
        if (deleteStmt.run(branch, cutoff).changes > 0) deleted.push(branch);
      }
    });
    // Rows and map evict as one unit: on a deferred (BUSY) transaction
    // neither changes, so the next cycle simply re-prunes the same rows — and
    // a branch whose row survived the re-guard keeps its map entry too, so
    // reload() can never resurrect a half-evicted pair.
    persistOrWarn("branch-cache", () => {
      runDeletes(toDelete);
      for (const branch of deleted) delete entries[branch];
    }, { op: "gc", count: toDelete.length });
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
