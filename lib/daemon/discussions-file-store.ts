/**
 * Discussions file store — one snapshot per MR, keyed "repo:iid", at
 * ~/.rt/discussions.json. Lifted out of CacheEntry.discussions (spec §5.5)
 * so teammate MRs (which have no branch entry) have a home.
 *
 * This module must not import freshness.ts (freshness imports it), so it
 * holds no provider logic — pure persistence.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Discussion } from "@workforge/glance-sdk";
import { RT_DIR } from "../daemon-config.ts";
import type { CacheEntry } from "./handlers/types.ts";

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
