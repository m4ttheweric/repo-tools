/**
 * The one place that decides whether a locate runs in the daemon or in this
 * process.
 *
 * The daemon is the single writer of the worktree registry, so a locate must
 * never run locally while it answers: a reconcile pass landing between the
 * index write and the registry write is exactly the prune this feature exists
 * to prevent. A daemon that is up but does not answer is a hard stop, not a
 * fall-through — `daemonSocketQuery` is the read-only client, so probing never
 * starts a daemon or warns.
 */

import { daemonSocketQuery, isDaemonRunning } from "./daemon-client.ts";
import { applyLocate, isRefusal, planLocate, type LocatePlan, type LocateResult } from "./repo-locate.ts";

/** git worktree repair across a large pool is the slow part; the 2s default IPC timeout is a client number, not a daemon-op one. */
export const LOCATE_TIMEOUT_MS = 2 * 60_000;

export type LocateOutcome =
  | { via: "daemon" | "local"; ok: true; dryRun: false; result: LocateResult }
  | { via: "daemon" | "local"; ok: true; dryRun: true; plan: LocatePlan }
  | { via: "daemon" | "local"; ok: false; error: string };

export async function locateMovedRepo(req: {
  newPath: string;
  repo?: string;
  dryRun?: boolean;
}): Promise<LocateOutcome> {
  const dryRun = req.dryRun === true;

  if (await isDaemonRunning()) {
    const res = await daemonSocketQuery(
      "repos:locate",
      { newPath: req.newPath, ...(req.repo ? { repo: req.repo } : {}), dryRun },
      LOCATE_TIMEOUT_MS,
    );
    if (!res) {
      return {
        via: "daemon",
        ok: false,
        error: "the rt daemon is running but did not answer repos:locate — not applying locally, which would race the worktree reconciler",
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
