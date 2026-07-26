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
  seedDiscussionsFromBranchCache,
  getDiscussionsFileStore,
  type DiscussionsFileStore,
} from "./discussions-file-store.ts";
import { getProjectMRs, type ProjectMRs } from "./project-mrs-store.ts";
import { loadRepoTracking, grants, type RepoTracking } from "../repo-tracking.ts";
import type { HandlerContext, CacheEntry } from "./handlers/types.ts";
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

/**
 * Sweep targets = branch-cache MRs (any status not yet terminal) for granted
 * repos, PLUS project-store MRs whose discussions are already cached
 * (demand-following: sweep cost tracks what consumers looked at, not project
 * size). Both sources require the "discussions" grant.
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
    const iid = entry.mr?.iid;
    if (typeof iid !== "number") continue;
    if (TERMINAL_STATES.has(entry.mr.status)) continue;
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

async function sweep(env: PollerEnv): Promise<void> {
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
