/**
 * Discussions file store — one snapshot per MR, keyed "repo:iid", at
 * ~/.mattstack/rt/discussions.json. Lifted out of CacheEntry.discussions (spec §5.5)
 * so teammate MRs (which have no branch entry) have a home.
 *
 * This module must not import freshness.ts (freshness imports it), so it
 * holds no provider logic — pure persistence.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Discussion } from "@mattstack/glance";
import { RT_DIR } from "../daemon-config.ts";
import type { CacheEntry } from "./handlers/types.ts";
import type { ProjectMRs } from "./project-mrs-store.ts";

export const DISCUSSIONS_PATH = join(RT_DIR, "discussions.json");

export interface DiscussionsEntry { discussions: Discussion[]; fetchedAt: number; }

export interface DiscussionsFileStore {
  read(repoName: string, iid: number): DiscussionsEntry | undefined;
  write(repoName: string, iid: number, entry: DiscussionsEntry): void;
  keys(): Array<{ repoName: string; iid: number }>;
  remove(repoName: string, iid: number): void;
  flushNow(): void;
}

const keyOf = (repoName: string, iid: number) => `${repoName}:${iid}`;

export function createDiscussionsFileStore(filePath: string = DISCUSSIONS_PATH): DiscussionsFileStore {
  let map: Record<string, DiscussionsEntry> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
  } catch { /* missing or corrupt → cold start */ }

  function flushNow(): void {
    try {
      writeFileSync(filePath, JSON.stringify(map, null, 2));
    } catch { /* write failure degrades to in-memory; next write retries */ }
  }

  return {
    read: (repoName, iid) => map[keyOf(repoName, iid)],
    write: (repoName, iid, entry) => { map[keyOf(repoName, iid)] = entry; flushNow(); },
    keys: () => Object.keys(map).map((k) => {
      const sep = k.lastIndexOf(":");
      return { repoName: k.slice(0, sep), iid: Number(k.slice(sep + 1)) };
    }),
    remove: (repoName, iid) => { delete map[keyOf(repoName, iid)]; flushNow(); },
    flushNow,
  };
}

let singleton: DiscussionsFileStore | null = null;
export function getDiscussionsFileStore(): DiscussionsFileStore {
  if (!singleton) singleton = createDiscussionsFileStore();
  return singleton;
}

/**
 * One-time upgrade seed: copy any discussions still embedded in branch-cache
 * entries into the file store. Entries without a repoName can't be keyed and
 * are skipped (they die by attrition); existing store entries are never
 * overwritten (the store is newer by construction). Returns copies made.
 */
export function seedDiscussionsFromBranchCache(
  entries: Record<string, CacheEntry>,
  store: DiscussionsFileStore = getDiscussionsFileStore(),
): number {
  let copied = 0;
  for (const entry of Object.values(entries)) {
    if (!entry.repoName || !entry.discussions || typeof entry.mr?.iid !== "number") continue;
    if (store.read(entry.repoName, entry.mr.iid)) continue;
    store.write(entry.repoName, entry.mr.iid, {
      discussions: entry.discussions,
      fetchedAt: entry.discussionsFetchedAt ?? 0,
    });
    copied++;
  }
  return copied;
}

/**
 * Union-membership prune: a discussions snapshot survives if its MR is live
 * in EITHER the branch cache or the project-MR store. Everything else is an
 * orphan (the MR fell out of both cache-refresh passes) and gets dropped.
 * Repos whose cache-refresh pass failed this cycle are exempt — a transient
 * failure must never look like "the MR disappeared".
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
