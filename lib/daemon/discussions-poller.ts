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
import { seedDiscussionsFromBranchCache } from "./discussions-file-store.ts";
import { loadRepoTracking, grants } from "../repo-tracking.ts";
import type { HandlerContext } from "./handlers/types.ts";
import { getDaemonLogger } from "../daemon-logger.ts";
const log = (await getDaemonLogger()).childLogger("discussions");

const POLL_INTERVAL_MS = 5 * 60 * 1000;

const TERMINAL_STATES = new Set(["merged", "closed"]);

export interface PollerEnv {
  ctx:       HandlerContext;
  broadcast: BroadcastFn;
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

async function sweep(env: PollerEnv): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const targets: Array<{ repoName: string; iid: number }> = [];
    const tracking = loadRepoTracking();
    for (const entry of Object.values(env.ctx.cache.entries)) {
      if (!entry.repoName) continue;
      // The background discussions sweep requires the "discussions" grant.
      if (!grants(tracking, entry.repoName).caches.has("discussions")) continue;
      const mr = entry.mr;
      const iid = mr?.iid;
      if (typeof iid !== "number") continue;
      if (TERMINAL_STATES.has(mr.status)) continue;
      targets.push({ repoName: entry.repoName, iid });
    }

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

export function startDiscussionsPoller(env: PollerEnv): void {
  if (timer) return;
  // One-time upgrade: move any discussions still embedded in branch-cache
  // entries into the file store before the first sweep reads it.
  const seeded = seedDiscussionsFromBranchCache(env.ctx.cache.entries);
  if (seeded > 0) log.info({ seeded }, "seeded discussions store from branch cache");
  log.info(`starting (every ${POLL_INTERVAL_MS / 1000}s)`);
  // Kick off a first sweep after a short delay so the daemon finishes
  // initializing freshness watchers before we start hitting GitLab.
  setTimeout(() => { sweep(env); }, 10_000);
  timer = setInterval(() => { sweep(env); }, POLL_INTERVAL_MS);
}

export function stopDiscussionsPoller(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
