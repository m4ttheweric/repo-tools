/**
 * Background cache refresh — discovers branches across tracked repos, enriches
 * them with MR/Linear data, and runs the post-refresh hooks (notifications,
 * auto-parking, doppler-template sync, status broadcast, freshness-watcher
 * reconcile).
 *
 * Concurrent callers are coalesced: the 5-minute timer and `cache:refresh` IPC
 * both fire-and-forget into the returned function. Without a guard they stack
 * up, each running execSync across every repo + a batch GraphQL. If a refresh
 * is already in flight, callers await the existing run instead of starting a
 * second one.
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import type { Logger } from "pino";
import type { DiskCache } from "./branch-cache.ts";
import type { PortCacheRef, RepoIndex } from "./handlers/types.ts";
import { checkAndNotify } from "../notifier.ts";
import { getCurrentUserId } from "./freshness.ts";
import { checkAndPark } from "./parking-lot.ts";
import { reconcileForRepo } from "./doppler-sync.ts";
import { listWorktreeRoots, listWorktrees } from "../git-worktrees.ts";

export interface CacheRefresherDeps {
  log: Logger;
  cache: DiskCache;
  loadCache: () => void;
  refreshStatusRef: { lastRefreshAt: number };
  portCacheRef: PortCacheRef;
  repoIndex: () => RepoIndex;
  broadcast: (type: string, data: any) => void;
  /** Full daemon status payload for the post-refresh "status" broadcast. */
  statusSnapshot: () => Promise<any>;
  /** Reconcile freshness watchers against the freshly-loaded repo index. */
  reconcileSubscriptions: () => Promise<void>;
}

export function createCacheRefresher(deps: CacheRefresherDeps): () => Promise<void> {
  const { log, cache, loadCache, refreshStatusRef, portCacheRef, repoIndex, broadcast } = deps;

  let refreshInFlight: Promise<void> | null = null;

  function refreshCache(): Promise<void> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = refreshCacheImpl().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  async function refreshCacheImpl(): Promise<void> {
    log.debug("cache: starting background refresh");

    try {
      // Dynamic imports to avoid loading heavy deps if not needed
      const { refreshAllMRs } = await import("../enrich.ts");
      const { extractLinearId } = await import("../linear.ts");
      const repos = repoIndex();

      for (const [repoName, repoPath] of Object.entries(repos)) {
        if (!existsSync(repoPath)) continue;

        try {
          // 1. Discover worktree branches (detached worktrees have no branch)
          const branches: Array<{ path: string; branch: string }> =
            listWorktrees(repoPath).filter((w) => w.branch);

          // 2. Discover local branches (not just worktrees)
          const worktreeBranchSet = new Set(branches.map(b => b.branch));
          try {
            const localBranchOutput = execSync(
              "git for-each-ref --format='%(refname:short)' refs/heads/",
              { cwd: repoPath, encoding: "utf8", stdio: "pipe" },
            );

            for (const name of localBranchOutput.split("\n")) {
              const trimmed = name.trim().replace(/^'|'$/g, "");
              if (!trimmed || worktreeBranchSet.has(trimmed)) continue;
              if (extractLinearId(trimmed)) {
                branches.push({ path: repoPath, branch: trimmed });
              }
            }
          } catch (err) {
            log.warn({ err, repo: repoPath }, "local branch listing failed");
          }

          if (branches.length > 0) {
            // Get remote URL
            let remoteUrl: string | undefined;
            try {
              remoteUrl = execSync("git config --get remote.origin.url", {
                cwd: repoPath, encoding: "utf8", stdio: "pipe",
              }).trim();
            } catch { /* no remote */ }

            // Optimized: 3 GraphQL calls for ALL open MRs + 1 Linear batch.
            // The onError callback fires on per-MR enrich failures (GitLab,
            // Linear) — recoverable, belongs at warn level.
            await refreshAllMRs(branches, remoteUrl, (msg) => log.warn({ repo: repoName }, msg), repoName);
          }
        } catch (err) {
          log.warn({ err, repo: repoName }, "cache refresh skipped repo");
        }
      }

      // Reload cache from disk (enrichBranches writes to disk)
      loadCache();
      refreshStatusRef.lastRefreshAt = Date.now();
      log.debug({ count: Object.keys(cache.entries).length }, "cache refresh complete");

      // Check for state transitions and fire notifications
      checkAndNotify(cache.entries, portCacheRef.ports, getCurrentUserId());

      // Auto-park worktrees whose MRs just merged/closed.
      try {
        checkAndPark({ cache, repoIndex });
      } catch (err) {
        log.warn({ err }, "parking-lot check failed");
      }

      // Doppler-template reconciliation: keeps ~/.doppler/.doppler.yaml in sync
      // with each repo's ~/.rt/repos/<repo>/doppler-template.yaml. Cheap (file I/O
      // only) and additive — never overwrites existing entries.
      for (const [repoName, repoPath] of Object.entries(repoIndex())) {
        if (!existsSync(repoPath)) continue;
        try {
          const worktreeRoots = listWorktreeRoots(repoPath);
          const summary = await reconcileForRepo({ repoName, worktreeRoots });
          if (summary.skipped) {
            if (summary.skipped === "malformed-template") {
              log.debug({ repo: repoName, skipped: summary.skipped }, "doppler sync skipped");
            }
            // "no-template" is the silent opt-out case; do not log.
            continue;
          }
          if (summary.wrote > 0 || summary.overridden > 0) {
            log.info({ repo: repoName, ...summary }, "doppler sync");
          }
        } catch (err) {
          log.error({ err, repo: repoName }, "doppler sync failed");
        }
      }

      // Broadcast to WebSocket clients
      broadcast("status", await deps.statusSnapshot());

      // Reconcile events watchers against the repo index. Starts/stops
      // per-repo watchers as repos are added/removed.
      deps.reconcileSubscriptions().catch((err) => {
        log.error({ err }, "freshness: reconcile failed");
      });
    } catch (err) {
      log.error({ err }, "cache refresh failed");
    }
  }

  return refreshCache;
}
