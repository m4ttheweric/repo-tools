/**
 * The one place that decides whether a locate runs in the daemon or in this
 * process.
 *
 * The daemon is the single writer of the worktree registry, so a locate must
 * never run locally while it is present: a reconcile pass landing between the
 * index write and the registry write is exactly the prune this feature exists
 * to prevent. Presence is decided from liveness EVIDENCE (a live pid, or the
 * socket file existing) rather than a ping: an event-loop-stalled daemon —
 * alive, holding the registry, just not servicing requests — fails a ping
 * exactly like a dead one does, and treating that as "absent" would take the
 * local branch anyway and race the very daemon still holding the registry. So
 * once presence is established, an unanswered `repos:locate` is a hard stop,
 * never a fall-through — `daemonSocketQuery` is the read-only client, so
 * probing never starts a daemon or warns.
 */

import { existsSync } from "fs";
import { daemonSocketQuery } from "./daemon-client.ts";
import { DAEMON_SOCK_PATH, isDaemonProcessRunning } from "./daemon-config.ts";
import { applyLocate, isRefusal, planLocate, type LocatePlan, type LocateResult } from "./repo-locate.ts";

/** git worktree repair across a large pool is the slow part; the 2s default IPC timeout is a client number, not a daemon-op one. */
export const LOCATE_TIMEOUT_MS = 2 * 60_000;

export type LocateOutcome =
  | { via: "daemon" | "local"; ok: true; dryRun: false; result: LocateResult }
  | { via: "daemon" | "local"; ok: true; dryRun: true; plan: LocatePlan }
  | { via: "daemon" | "local"; ok: false; error: string };

/** A live pid file OR a socket file on disk — either is evidence the daemon holds the registry, whether or not it is currently answering requests. */
function daemonPresent(): boolean {
  return isDaemonProcessRunning() || existsSync(DAEMON_SOCK_PATH);
}

export async function locateMovedRepo(req: {
  newPath: string;
  repo?: string;
  dryRun?: boolean;
}): Promise<LocateOutcome> {
  const dryRun = req.dryRun === true;

  if (daemonPresent()) {
    const res = await daemonSocketQuery(
      "repos:locate",
      { newPath: req.newPath, ...(req.repo ? { repo: req.repo } : {}), dryRun },
      LOCATE_TIMEOUT_MS,
    );
    if (!res) {
      return {
        via: "daemon",
        ok: false,
        error: "the rt daemon is present but did not answer repos:locate; not applying locally (would race the worktree reconciler) — check `rt daemon status` and retry",
      };
    }
    if (!res.ok) return { via: "daemon", ok: false, error: res.error ?? "repos:locate failed" };
    return dryRun
      ? { via: "daemon", ok: true, dryRun: true, plan: res.data.plan as LocatePlan }
      : { via: "daemon", ok: true, dryRun: false, result: res.data as LocateResult };
  }

  const plan = await planLocate({ newPath: req.newPath, repo: req.repo });
  if (isRefusal(plan)) return { via: "local", ok: false, error: `${plan.refusal}: ${plan.message}` };
  if (dryRun) return { via: "local", ok: true, dryRun: true, plan };

  const result = await applyLocate(plan);
  return result.ok
    ? { via: "local", ok: true, dryRun: false, result }
    : { via: "local", ok: false, error: result.error ?? "locate failed" };
}
