/**
 * Discussions store — one row per MR snapshot, keyed (repo, iid), in the
 * `discussions` table of state.db. Lifted out of CacheEntry.discussions
 * (spec §5.5) so teammate MRs (which have no branch entry) have a home;
 * RT-48 moved persistence off discussions.json onto state.db (spec
 * docs/superpowers/specs/2026-08-20-rt-statedb.md "Tables (v1)"
 * (`discussions`) and "Store-by-store" item 3).
 *
 * This module must not import freshness.ts (freshness imports it), so it
 * holds no provider logic — pure persistence.
 *
 * write()/remove() are now single-row upsert/delete statements (no more
 * whole-map `writeFileSync` on every touch) run through the shared
 * daemon-flavor busy-defer wrapper (lib/state/busy.ts, extracted from
 * project-mrs-store.ts's Task 4 pattern): a SQLITE_BUSY write is warned and
 * swallowed rather than thrown, converging on the next successful write.
 * Unlike branch-cache/project-mrs, this store keeps no in-memory map of its
 * own — `read()` always queries the table directly — so a swallowed write
 * is a real (if rare, bounded by the 250ms daemon busy_timeout) staleness
 * window, accepted for the same reason cache writes generally are (spec
 * "The database": "cache writes stay defer-and-move-on").
 */

import { Database } from "bun:sqlite";
import type { Discussion } from "@mattstack/glance";
import { getStateDb, LEGACY_IMPORTS } from "../state/db.ts";
import { persistOrWarn } from "../state/busy.ts";
import { rekeyTableColumn, type RekeyReport } from "../state/identity-migrate.ts";
import type { ProjectMRs } from "./project-mrs-store.ts";
import type { CacheEntry } from "./handlers/types.ts";

/**
 * One-shot: re-key legacy NAME-keyed `discussions` rows onto serialized
 * identities. Exported for the daemon-boot migration runner; this module
 * does not wire the boot call.
 */
export function rekeyDiscussionsTable(): Promise<RekeyReport> {
  return rekeyTableColumn("discussions", "repo");
}

export interface DiscussionsEntry { discussions: Discussion[]; fetchedAt: number; }

export interface DiscussionsFileStore {
  read(repoName: string, iid: number): DiscussionsEntry | undefined;
  write(repoName: string, iid: number, entry: DiscussionsEntry): void;
  keys(): Array<{ repoName: string; iid: number }>;
  remove(repoName: string, iid: number): void;
}

interface DiscussionRow { repo: string; iid: number; discussions: string; fetched_at: number; }

const UPSERT_SQL = `
  INSERT INTO discussions (repo, iid, discussions, fetched_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(repo, iid) DO UPDATE SET discussions = excluded.discussions, fetched_at = excluded.fetched_at
`;

export function createDiscussionsFileStore(db: Database = getStateDb("daemon")): DiscussionsFileStore {
  const upsertStmt = db.query(UPSERT_SQL);
  const deleteStmt = db.query(`DELETE FROM discussions WHERE repo = ? AND iid = ?;`);
  const readStmt = db.query(`SELECT discussions, fetched_at FROM discussions WHERE repo = ? AND iid = ?;`);
  const keysStmt = db.query(`SELECT repo, iid FROM discussions;`);

  return {
    read(repoName, iid) {
      const row = readStmt.get(repoName, iid) as Pick<DiscussionRow, "discussions" | "fetched_at"> | null;
      if (!row) return undefined;
      return { discussions: JSON.parse(row.discussions) as Discussion[], fetchedAt: row.fetched_at };
    },
    write(repoName, iid, entry) {
      persistOrWarn(
        "discussions",
        () => { upsertStmt.run(repoName, iid, JSON.stringify(entry.discussions), entry.fetchedAt); },
        { repo: repoName, iid, op: "write" },
      );
    },
    keys() {
      return (keysStmt.all() as Pick<DiscussionRow, "repo" | "iid">[]).map((r) => ({ repoName: r.repo, iid: r.iid }));
    },
    remove(repoName, iid) {
      persistOrWarn(
        "discussions",
        () => { deleteStmt.run(repoName, iid); },
        { repo: repoName, iid, op: "remove" },
      );
    },
  };
}

let singleton: DiscussionsFileStore | null = null;
export function getDiscussionsFileStore(): DiscussionsFileStore {
  if (!singleton) singleton = createDiscussionsFileStore();
  return singleton;
}

/**
 * Union-membership prune: a discussions snapshot survives if its MR is live
 * in EITHER the branch cache or the project-MR store. Everything else is an
 * orphan (the MR fell out of both cache-refresh passes) and gets dropped.
 * Repos whose cache-refresh pass failed this cycle are exempt — a transient
 * failure must never look like "the MR disappeared".
 *
 * RT-48 intended semantic change (spec "Store-by-store" item 3, review r1
 * finding 12): branch-cache GC now actually shrinks the branch-cache leg of
 * this union (branch-cache previously had no prune at all), so a discussion
 * for a >30-day-stale branch with no open MR — one that GC has evicted from
 * branch_cache, and that never landed in the project-MR store either — now
 * gets pruned here too. That is intended cleanup riding on the new GC, not
 * a parity requirement with the old file-store behavior; it was previously
 * impossible for a discussion to become an "orphan" this way because the
 * branch-cache leg of the union never shrank on its own.
 */
export function pruneDiscussionsStore(opts: {
  entries: Record<string, CacheEntry>;
  projectStore: ProjectMRs;
  failedRepos?: ReadonlySet<string>;
  store?: DiscussionsFileStore;
}): number {
  const store = opts.store ?? getDiscussionsFileStore();
  const live = new Set<string>();
  for (const entry of Object.values(opts.entries)) {
    if (entry.repoName && typeof entry.mr?.iid === "number") live.add(`${entry.repoName}:${entry.mr.iid}`);
  }
  for (const [repoName, record] of Object.entries(opts.projectStore.data)) {
    for (const iid of Object.keys(record.mrs)) live.add(`${repoName}:${iid}`);
  }
  let removed = 0;
  for (const { repoName, iid } of store.keys()) {
    if (opts.failedRepos?.has(repoName)) continue;   // never prune on a failed pass
    if (live.has(`${repoName}:${iid}`)) continue;
    store.remove(repoName, iid);
    removed++;
  }
  return removed;
}

// ─── Legacy import (discussions.json → discussions rows) ───────────────────
//
// Root shape: Record<"repoName:iid", { discussions, fetchedAt }> — the file
// store's own in-memory map shape, unchanged since introduction. Key split
// on the LAST ":" (repo names never contain one; iid is numeric tail).

interface LegacyDiscussionsEntry { discussions?: Discussion[]; fetchedAt?: number; }

LEGACY_IMPORTS.push({
  file: "discussions.json",
  import: (db, json) => {
    const parsed = json as Record<string, LegacyDiscussionsEntry | undefined> | null;
    if (!parsed || typeof parsed !== "object") return;

    const stmt = db.query(UPSERT_SQL);
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry) continue;
      const sep = key.lastIndexOf(":");
      if (sep < 0) continue;
      const repoName = key.slice(0, sep);
      const iid = Number(key.slice(sep + 1));
      if (!repoName || !Number.isFinite(iid)) continue;
      stmt.run(repoName, iid, JSON.stringify(entry.discussions ?? []), entry.fetchedAt ?? 0);
    }
  },
});
