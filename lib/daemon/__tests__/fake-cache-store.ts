/**
 * In-memory stand-in for the branch-cache store (`lib/state/branch-cache.ts`)
 * for handler tests that only care about `entries`.
 *
 * RT-48: handler fakes used to be `{ cache: { entries }, flushCache, loadCache }`.
 * `ctx.cache` is now the store itself, so a fake has to answer the whole
 * BranchCacheStore surface — the map half, with no db behind it. Tests that
 * want to ASSERT persistence should use a real store over
 * `openStateDb(tempPath)` instead of this.
 */

import type { BranchCacheStore, CacheEntry } from "../../state/index.ts";
import { composeKey } from "../../state/branch-cache.ts";

export function fakeStore(entries: Record<string, CacheEntry> = {}): BranchCacheStore {
  return {
    entries,
    // Mirrors the real store's put (Task 10): keyed by composeKey(entry.repoName,
    // branch), not the bare branch, so a fixture pre-seeded under a composite
    // key stays addressable at the same key after a consumer writes through it.
    put(branch, entry) { entries[composeKey(entry.repoName, branch)] = entry; },
    delete(branch) { delete entries[branch]; },
    reload() { /* no db behind this fake — the map is the whole store */ },
    gc() { /* GC is exercised against a real store, not here */ },
  };
}
