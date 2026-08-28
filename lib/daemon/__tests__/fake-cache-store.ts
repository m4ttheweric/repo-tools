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

import { composeKey } from "../../state/branch-cache.ts";
import type { BranchCacheStore, CacheEntry } from "../../state/index.ts";

export function fakeStore(entries: Record<string, CacheEntry> = {}): BranchCacheStore {
  return {
    entries,
    put(branch, entry) { entries[branch] = entry; },
    delete(branch) { delete entries[branch]; },
    reload() { /* no db behind this fake, the map is the whole store */ },
    gc() { /* GC is exercised against a real store, not here */ },
    get(identity, branch) { return entries[composeKey(identity, branch)]; },
    getByBranch(branch) {
      const suffix = `:${branch}`;
      for (const [k, v] of Object.entries(entries)) if (k === branch || k.endsWith(suffix)) return v;
      return undefined;
    },
  };
}
