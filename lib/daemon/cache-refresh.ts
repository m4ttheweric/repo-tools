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
import type { PortCacheRef, RepoIndex } from "./handlers/types.ts";
import type { BranchCacheStore } from "../state/index.ts";
import { checkAndNotify } from "../notifier.ts";
import { getCurrentUserId } from "./freshness.ts";
import { loadRepoTracking, grants } from "../repo-tracking.ts";
import { syncProjectMRs } from "./project-sync.ts";
import { getProjectMRs } from "./project-mrs-store.ts";
import { pruneDiscussionsStore } from "./discussions-file-store.ts";
import { reconcileForRepo } from "./doppler-sync.ts";
import { listWorktreeRoots, listWorktrees } from "../git-worktrees.ts";

export interface CacheRefresherDeps {
  log: Logger;
  /** The process-wide branch-cache store; `cache.reload()` replaces the old read-from-disk. */
  cache: BranchCacheStore;
  refreshStatusRef: { lastRefreshAt: number };
  portCacheRef: PortCacheRef;
  repoIndex: () => RepoIndex;
  broadcast: (type: string, data: any) => void;
  /** Full daemon status payload for the post-refresh "status" broadcast. */
  statusSnapshot: () => Promise<any>;
  /** Reconcile freshness watchers against the freshly-loaded repo index. */
  reconcileSubscriptions: () => Promise<void>;
  /** Fire-and-forget kick of the worktree reconciler after each refresh. */
  worktreeKick?: () => void;
}

export function createCacheRefresher(deps: CacheRefresherDeps): () => Promise<void> {
  const { log, cache, refreshStatusRef, portCacheRef, repoIndex, broadcast } = deps;

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
      const tracking = loadRepoTracking();
      const failedRepos = new Set<string>();

      for (const [repoName, repoPath] of Object.entries(repos)) {
        if (!existsSync(repoPath)) continue;

        const g = grants(tracking, repoName);
        if (g.caches.size === 0) continue; // off: zero background work

        // Project list sync (member-blind team view) — its own grant.
        if (g.caches.has("project-mrs")) {
          try {
            await syncProjectMRs({ repoIndex, broadcast }, repoName);
          } catch (err) {
            log.warn({ err, repo: repoName }, "project sync failed");
            failedRepos.add(repoName);
          }
        }

        // Branch-view enrichment requires the "branches" grant.
        if (!g.caches.has("branches")) continue;

        try {
          // 1. Discover worktree branches (detached worktrees have no branch).
          // on-deck/* branches are pool plumbing, not feature work — never
          // worth MR/Linear enrichment.
          const branches: Array<{ path: string; branch: string }> = listWorktrees(repoPath).filter(
            (w) => w.branch && !w.branch.startsWith("on-deck/"),
          );

          // 2. Discover local branches (not just worktrees)
          const worktreeBranchSet = new Set(branches.map(b => b.branch));
          try {
            const localBranchOutput = execSync(
              "git for-each-ref --format='%(refname:short)' refs/heads/",
              { cwd: repoPath, encoding: "utf8", stdio: "pipe" },
            );

            for (const name of localBranchOutput.split("\n")) {
              const trimmed = name.trim().replace(/^'|'$/g, "");
              if (!trimmed || worktreeBranchSet.has(trimmed) || trimmed.startsWith("on-deck/")) continue;
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
          failedRepos.add(repoName);
        }
      }

      // Rebuild the in-memory map from state.db in one SELECT. refreshAllMRs
      // above already wrote through the same singleton store in this process,
      // but a CLI `rt run` enrichment may have upserted rows concurrently —
      // this is where those become visible (spec "In-memory ownership").
      cache.reload();
      refreshStatusRef.lastRefreshAt = Date.now();
      log.debug({ count: Object.keys(cache.entries).length }, "cache refresh complete");

      // Discussions prune: drop snapshots whose MR is in neither store.
      // failedRepos are exempt — never prune on a failed pass.
      try {
        const removed = pruneDiscussionsStore({
          entries: cache.entries,
          projectStore: getProjectMRs(),
          failedRepos,
        });
        if (removed > 0) log.debug({ removed }, "discussions prune");
      } catch (err) {
        log.warn({ err }, "discussions prune failed");
      }

      // Check for state transitions and fire notifications
      checkAndNotify(cache.entries, portCacheRef.ports, getCurrentUserId());

      // Doppler-template reconciliation: keeps ~/.doppler/.doppler.yaml in sync
      // with each repo's ~/.mattstack/rt/repos/<repo>/doppler-template.yaml. Cheap (file I/O
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

      // Kick the worktree reconciler (freshen/replenish/shrink/reactor).
      // Detached: `kick()` itself is fire-and-forget and coalesces overlap,
      // so this never delays the refresh cycle it rides in on.
      deps.worktreeKick?.();

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
