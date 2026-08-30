/**
 * Keeps `~/.mattstack/rt/cd-cache.json` warm so `rt cd` can serve its picker
 * list from disk instead of rebuilding the repo index live on every
 * invocation. Wired into daemon.ts's background-subsystems unit via
 * scheduleSweep (boot-delay + recurring interval on one handle).
 *
 * `includeMissing: true` matches the options `rt cd` itself builds with, so
 * the cache and a live rebuild never disagree on rows.
 */

import type { Logger } from "pino";
import { getKnownReposAsync, type KnownRepo } from "../repo-index.ts";
import { writeRepoCache } from "../repo-cache.ts";

export const REFRESH_MS = 5 * 60_000;
export const BOOT_DELAY_MS = 10_000;

export interface CdCacheRefreshDeps {
  getKnownRepos?: (opts?: { includeMissing?: boolean }) => Promise<KnownRepo[]>;
  writeCache?: (repos: KnownRepo[]) => void;
  now?: () => number;
}

/**
 * One refresh tick. scheduleSweep already wraps timer callbacks in a
 * try/catch (and logs a warning on throw), but this stays defensive on its
 * own so a future caller that invokes it outside that wrapper is still safe.
 */
export async function refreshCdCache(log: Logger, deps: CdCacheRefreshDeps = {}): Promise<void> {
  const getRepos = deps.getKnownRepos ?? getKnownReposAsync;
  const write = deps.writeCache ?? writeRepoCache;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  try {
    const repos = await getRepos({ includeMissing: true });
    write(repos);
    log.debug({ rows: repos.length, durationMs: now() - startedAt }, "cd-cache refreshed");
  } catch (err) {
    log.warn({ err }, "cd-cache refresh tick failed");
  }
}
