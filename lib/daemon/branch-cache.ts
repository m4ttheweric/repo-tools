/**
 * Branch cache persistence — the on-disk MR/Linear/pipeline cache at
 * ~/.rt/branch-cache.json.
 *
 * The cache object keeps a stable reference across reloads: loadCache()
 * mutates `cache.entries` in place so handler modules can hold a live
 * reference via HandlerContext.cache.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Logger } from "pino";
import { RT_DIR } from "../daemon-config.ts";
import type { CacheEntry } from "./handlers/types.ts";

export const CACHE_PATH = join(RT_DIR, "branch-cache.json");

export interface DiskCache {
  entries: Record<string, CacheEntry>;
}

export interface BranchCache {
  cache: DiskCache;
  /** Reload cache.entries in-place from disk; used after enrichBranches writes. */
  loadCache(): void;
  /** Persist cache.entries to disk. */
  flushCache(): void;
}

export function createBranchCache(log: Logger): BranchCache {
  const cache: DiskCache = { entries: {} };

  function loadCache(): void {
    try {
      const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
      cache.entries = parsed?.entries ?? {};
    } catch {
      cache.entries = {};
    }
  }

  function flushCache(): void {
    try {
      writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch (err) {
      log.error({ err }, "cache flush failed");
    }
  }

  return { cache, loadCache, flushCache };
}
