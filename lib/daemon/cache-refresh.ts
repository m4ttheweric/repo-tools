/**
 * Background cache refresh — discovers branches across tracked repos, enriches
 * them with MR/Linear data, and runs the post-refresh hooks (notifications,
 * auto-parking, doppler-template sync, status broadcast, freshness-watcher
 * reconcile).
 *
 * Concurrent callers are coalesced: the 5-minute timer and `cache:refresh` IPC
 * both fire-and-forget into the returned function. Without a guard they stack
 * up, each running async git across every repo + a batch GraphQL. If a refresh
 * is already in flight, callers await the existing run instead of starting a
 * second one.
 */

import { existsSync } from "fs";
import type { Logger } from "pino";
import type { PortCacheRef, RepoIndex } from "./handlers/types.ts";
import type { BranchCacheStore } from "../state/index.ts";
import { checkAndNotify } from "../notifier.ts";
import { getCurrentUserId, resolveUserIdAcrossTracking } from "./freshness.ts";
import { loadRepoTracking, grants } from "../repo-tracking.ts";
import { syncProjectMRs } from "./project-sync.ts";
import { getProjectMRs } from "./project-mrs-store.ts";
import { pruneDiscussionsStore } from "./discussions-file-store.ts";
import { reconcileForRepo } from "./doppler-sync.ts";
import { deriveRepoIdentity } from "../settings/identity.ts";
import { listWorktreesAsync, listWorktreeRootsAsync, runGit } from "../worktree/git-async.ts";

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

/**
 * Branch-cache rows older than this are eligible for GC. A constant, not a
 * setting (spec "New: branch-cache GC": "30 days is a constant").
 */
const BRANCH_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Below the 5-min tick, above the slowest legitimate deep sync. */
const REFRESH_CYCLE_DEADLINE_MS = 4 * 60 * 1000;

/**
 * Coalesce concurrent callers onto one in-flight run, but clear the latch after
 * `deadlineMs` even if the run never settles, so a wedged cycle (a half-open
 * GitLab socket that never rejects) cannot pin the latch forever. The wedged
 * run's frame still leaks until the OS reaps the socket; this only frees the
 * next tick.
 */
export function makeCoalescer(
  run: () => Promise<void>,
  deadlineMs: number,
  onTimeout: () => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const impl = run().catch(() => {}); // a rejected cycle still clears the latch
    // Promise.race never cancels the losing branch, so the deadline timer must be
    // captured and cleared on every settle path or a fast success still fires
    // onTimeout deadlineMs later, misreported as a wedge.
    let deadlineTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => { onTimeout(); resolve(); }, deadlineMs);
    });
    const guarded = Promise.race([impl, deadline]).finally(() => {
      clearTimeout(deadlineTimer);
      inFlight = null;
    });
    inFlight = guarded;
    return guarded;
  };
}

export function createCacheRefresher(deps: CacheRefresherDeps): () => Promise<void> {
  const { log, cache, refreshStatusRef, portCacheRef, repoIndex, broadcast } = deps;

  const refreshCache = makeCoalescer(
    refreshCacheImpl,
    REFRESH_CYCLE_DEADLINE_MS,
    () => log.warn("cache refresh timed out; cleared in-flight latch for next tick"),
  );

  async function refreshCacheImpl(): Promise<void> {
    log.debug("cache: starting background refresh");

    try {
      // Dynamic imports to avoid loading heavy deps if not needed
      const { refreshAllMRs } = await import("../enrich.ts");
      const { extractLinearId } = await import("../linear.ts");
      const repos = repoIndex();
      const tracking = loadRepoTracking();
      const failedRepos = new Set<string>();
      // The GC gate (spec "New: branch-cache GC"): a repo's rows may be
      // aged out only in a cycle where ITS refresh completed with zero
      // `onError` invocations. A repo that is skipped here — untracked, no
      // "branches" grant, missing path — never enters this set, so its rows
      // are never pruned on a cycle that did not refresh them.
      const succeededRepos = new Set<string>();

      // `repos` keys on the serialized repo identity (repo-index.ts), so every
      // `repoName` below — passed on into refreshAllMRs, project-sync, and the
      // branch_cache/project_mrs rows those write — is that same identity.
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

        // `refreshAllMRs` swallows per-MR fetch failures into `onError` and
        // never throws, so a token-expired repo would sail through the
        // catch below looking clean while its `fetchedAt` stays frozen.
        // Counting onError calls is the only honest success signal (spec
        // "New: branch-cache GC", review r2 finding 1).
        let enrichErrors = 0;

        try {
          // 1. Discover worktree branches (detached worktrees have no branch).
          // on-deck/* branches are pool plumbing, not feature work — never
          // worth MR/Linear enrichment.
          const branches: Array<{ path: string; branch: string }> = ((await listWorktreesAsync(repoPath)) ?? [])
            .filter((w): w is { path: string; branch: string } => !!w.branch && !w.branch.startsWith("on-deck/"));

          // 2. Discover local branches (not just worktrees)
          const worktreeBranchSet = new Set(branches.map(b => b.branch));
          const localBranches = await runGit(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
          if (localBranches.exitCode === 0) {
            for (const name of localBranches.stdout.split("\n")) {
              const trimmed = name.trim();
              if (!trimmed || worktreeBranchSet.has(trimmed) || trimmed.startsWith("on-deck/")) continue;
              if (extractLinearId(trimmed)) {
                branches.push({ path: repoPath, branch: trimmed });
              }
            }
          } else {
            log.warn({ repo: repoPath }, "local branch listing failed");
          }

          if (branches.length > 0) {
            // Get remote URL
            let remoteUrl: string | undefined;
            const remote = await runGit(repoPath, ["config", "--get", "remote.origin.url"]);
            if (remote.exitCode === 0) remoteUrl = remote.stdout.trim() || undefined;

            // Optimized: 3 GraphQL calls for ALL open MRs + 1 Linear batch.
            // The onError callback fires on per-MR enrich failures (GitLab,
            // Linear) — recoverable, belongs at warn level.
            await refreshAllMRs(branches, remoteUrl, (msg) => {
              enrichErrors++;
              log.warn({ repo: repoName }, msg);
            }, repoName);
          }

          // Clean pass. `branches.length === 0` counts as clean on purpose:
          // the repo was walked and has nothing to enrich, so any rows still
          // attributed to it are leftovers and should age out normally.
          // A project-sync failure earlier in this iteration disqualifies the
          // repo too — a cycle that went wrong anywhere for a repo is not the
          // cycle to delete its rows on.
          if (enrichErrors === 0 && !failedRepos.has(repoName)) succeededRepos.add(repoName);
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

      // Branch-cache GC: age out rows the succeeded repos no longer refresh.
      // Runs BEFORE the discussions prune (spec "New: branch-cache GC",
      // placement) so both prunes see the same membership in the same cycle —
      // GC shrinks one leg of the discussions union, and a discussion whose
      // only anchor was an evicted branch must go in this cycle, not the next.
      // checkAndNotify's fired-ledger hygiene, further down, likewise sees the
      // post-GC map, so an evicted branch leaks no fired keys.
      try {
        cache.gc(succeededRepos, BRANCH_CACHE_MAX_AGE_MS);
      } catch (err) {
        log.warn({ err }, "branch-cache gc failed");
      }

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

      // S022: resolve userId for any branches/project-mrs tracked repo,
      // regardless of mode, BEFORE checkAndNotify — reconcileSubscriptions
      // (below) only ever reaches live-mode repos and only runs after this,
      // so a poll-only user's first cycle would otherwise still pass null.
      try {
        await resolveUserIdAcrossTracking(repos, tracking);
      } catch (err) {
        log.warn({ err }, "S022: userId resolution across tracked repos failed");
      }

      // Check for state transitions and fire notifications
      checkAndNotify(cache.entries, portCacheRef.ports, getCurrentUserId());

      // Doppler-template reconciliation: keeps ~/.doppler/.doppler.yaml in sync
      // with each repo's rt.dopplerTemplate setting. Cheap and additive —
      // never overwrites existing entries.
      for (const [repoName, repoPath] of Object.entries(repoIndex())) {
        if (!existsSync(repoPath)) continue;
        if (grants(tracking, repoName).caches.size === 0) continue; // off = zero background work
        try {
          const worktreeRoots = await listWorktreeRootsAsync(repoPath);
          const derivedIdentity = await deriveRepoIdentity(repoPath);
          const repoIdentity = derivedIdentity.kind === "remote" ? derivedIdentity.id : null;
          const summary = await reconcileForRepo({ repoIdentity, worktreeRoots });
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
