/**
 * Background poller for MR discussions.
 *
 * `mr-subscriptions` pushes GraphQL-level MR updates in real time via
 * ActionCable, but discussion threads are only available through REST. This
 * poller sweeps every tracked MR on a timer and calls `refreshDiscussions`,
 * which stores the snapshot and broadcasts `discussions:new-comments` +
 * `notification` whenever someone (other than the current user) posts a new
 * non-system note.
 *
 * Design notes:
 * - Polls every `POLL_INTERVAL_MS` (90s) — rare enough to be polite to
 *   GitLab's REST API, fast enough that a reply surfaces within 1–2 minutes.
 * - Only polls MRs in `open` / `mergeable` / `blocked` / `draft` state.
 *   Merged / closed MRs rarely receive new comments and aren't worth the
 *   round trip.
 * - Sweeps are serialized (one at a time) and skipped if a previous sweep
 *   is still running, so a slow GitLab or a large MR count can't pile up
 *   overlapping fetches.
 */

import { refreshDiscussions, type BroadcastFn } from "./discussions-store.ts";
import type { HandlerContext } from "./handlers/types.ts";

const POLL_INTERVAL_MS = 90 * 1000;

const TERMINAL_STATES = new Set(["merged", "closed"]);

export interface PollerEnv {
  ctx:       HandlerContext;
  broadcast: BroadcastFn;
  log:       (msg: string) => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

async function sweep(env: PollerEnv): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const targets: Array<{ repoName: string; iid: number }> = [];
    for (const entry of Object.values(env.ctx.cache.entries)) {
      if (!entry.repoName) continue;
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
        // Expected for MRs without a live subscription yet — keep going.
        env.log(`discussions-poller: ${repoName}#${iid} refresh failed: ${err}`);
      }
    }
  } finally {
    sweeping = false;
  }
}

export function startDiscussionsPoller(env: PollerEnv): void {
  if (timer) return;
  env.log(`discussions-poller: starting (every ${POLL_INTERVAL_MS / 1000}s)`);
  // Kick off a first sweep after a short delay so the daemon finishes
  // initializing subscriptions before we start hitting GitLab.
  setTimeout(() => { sweep(env); }, 10_000);
  timer = setInterval(() => { sweep(env); }, POLL_INTERVAL_MS);
}

export function stopDiscussionsPoller(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
