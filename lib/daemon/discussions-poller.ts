/**
 * Background poller for MR discussions.
 *
 * The freshness watchers refresh a specific MR's discussions within seconds
 * of a `notes:` invalidation, but two thread mutations emit no GitLab event
 * at all: resolve/unresolve toggles and note edits. This poller sweeps every
 * tracked MR on a slow timer and calls `refreshDiscussions`, which stores
 * the snapshot and broadcasts `discussions:new-comments` + `notification`
 * whenever someone (other than the current user) posts a new non-system note.
 *
 * Design notes:
 * - Polls every `POLL_INTERVAL_MS` (5 min) — the events path handles the
 *   fast cases; this sweep only backfills the event-less mutations above.
 * - Sweeps only repos granting the "discussions" cache, not every non-off
 *   repo — a repo tracked for branches alone gets no discussions polling.
 * - Only polls MRs in `open` / `mergeable` / `blocked` / `draft` state.
 *   Merged / closed MRs rarely receive new comments and aren't worth the
 *   round trip.
 * - Sweeps are serialized (one at a time) and skipped if a previous sweep
 *   is still running, so a slow GitLab or a large MR count can't pile up
 *   overlapping fetches.
 */

import { refreshDiscussions, type BroadcastFn } from "./discussions-store.ts";
import {
  getDiscussionsFileStore,
  type DiscussionsFileStore,
} from "./discussions-file-store.ts";
import { getProjectMRs, type ProjectMRs } from "./project-mrs-store.ts";
import { loadRepoTracking, grants, type RepoTracking } from "../repo-tracking.ts";
import type { HandlerContext, CacheEntry } from "./handlers/types.ts";
import { lazyChildLogger } from "../daemon-logger.ts";
import { MR_TERMINAL_STATES } from "../enrich.ts";
const log = lazyChildLogger("discussions");

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface PollerEnv {
  ctx:       HandlerContext;
  broadcast: BroadcastFn;
}

/**
 * Sweep targets = branch-cache MRs (any status not yet terminal) for granted
 * repos, PLUS project-store MRs whose discussions are already cached
 * (demand-following: sweep cost tracks what consumers looked at, not project
 * size). Both sources require the "discussions" grant.
 *
 * `repoName` throughout is the serialized repo identity: `entry.repoName`
 * comes from branch_cache.repo, `projectStore`'s keys from project_mrs_meta.repo
 * — both identity-keyed, so `grants(tracking, repoName)` and the `discussions`
 * rows this writes to are addressed by the same identity.
 */
export function collectSweepTargets(
  entries: Record<string, CacheEntry>,
  tracking: RepoTracking,
  projectStore: ProjectMRs,
  fileStore: DiscussionsFileStore,
): Array<{ repoName: string; iid: number }> {
  const out: Array<{ repoName: string; iid: number }> = [];
  const seen = new Set<string>();
  const add = (repoName: string, iid: number) => {
    const k = `${repoName}:${iid}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ repoName, iid });
  };

  for (const entry of Object.values(entries)) {
    if (!entry.repoName) continue;
    if (!grants(tracking, entry.repoName).caches.has("discussions")) continue;
    // `mr` is now typed `MRInfo | null` (RT-48 gave CacheEntry a real shape
    // instead of `any`), so narrow once and use the local.
    const mr = entry.mr;
    const iid = mr?.iid;
    if (!mr || typeof iid !== "number") continue;
    if (MR_TERMINAL_STATES.has(mr.status)) continue;
    add(entry.repoName, iid);
  }

  // Project-store MRs are swept only when their discussions are already
  // cached (demand-following): sweep cost tracks what consumers looked at,
  // not project size.
  for (const [repoName, record] of Object.entries(projectStore.data)) {
    if (!grants(tracking, repoName).caches.has("discussions")) continue;
    for (const [iidStr, mrEntry] of Object.entries(record.mrs)) {
      const iid = Number(iidStr);
      if (mrEntry.pr.state !== "opened") continue;
      if (!fileStore.read(repoName, iid)) continue;
      add(repoName, iid);
    }
  }
  return out;
}

export interface DiscussionsPoller {
  start(): void;
  stop(): void;
}

/**
 * R031: `timer`/`sweeping` used to be bare module-scope `let`s. Wraps them in
 * a closure so a second createDiscussionsPoller(env) can coexist without
 * sharing a timer handle or in-flight-sweep flag with the first.
 */
export function createDiscussionsPoller(env: PollerEnv): DiscussionsPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let sweeping = false;

  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    try {
      const tracking = loadRepoTracking();
      const targets = collectSweepTargets(env.ctx.cache.entries, tracking, getProjectMRs(), getDiscussionsFileStore());

      for (const { repoName, iid } of targets) {
        try {
          await refreshDiscussions({ ctx: env.ctx, broadcast: env.broadcast }, repoName, iid);
        } catch (err) {
          // Expected for a repo context that can't be resolved yet, or a
          // transient fetch failure — keep going.
          log.warn({ err }, `${repoName}#${iid} refresh failed`);
        }
      }
    } finally {
      sweeping = false;
    }
  }

  function start(): void {
    if (timer) return;
    log.info(`starting (every ${POLL_INTERVAL_MS / 1000}s)`);
    // Kick off a first sweep after a short delay so the daemon finishes
    // initializing freshness watchers before we start hitting GitLab. Captured
    // so stop() clears it too: an uncleared boot timer would fire a sweep
    // after the poller was torn down.
    bootTimer = setTimeout(() => { bootTimer = null; sweep(); }, 10_000);
    timer = setInterval(() => { sweep(); }, POLL_INTERVAL_MS);
  }

  function stop(): void {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop };
}

export const __test__ = { MR_TERMINAL_STATES };
