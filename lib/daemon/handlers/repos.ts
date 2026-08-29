/**
 * Repo-index IPC verbs.
 *
 * `repos:locate` runs the whole apply inside the reconciler's hold: a
 * reconcile pass that sees a healed index path against un-rewritten registry
 * paths prunes every registry row as "no matching worktree", and replenish
 * then mints replacement trees for a pool that never lost anything.
 */

import { decodeRepo } from "../identity-decoder.ts";
import { applyLocate, isRefusal, planLocate } from "../../repo-locate.ts";
import type { HandlerMap } from "./types.ts";

export interface ReposHandlerOpts {
  /** Excludes reconciler passes — not other registry writers — for the duration of `fn`. */
  withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Re-point the hooks guard's per-repo git-config watchers once paths have moved. */
  refreshWatchedRepos: () => void;
  /** Events-bus emit — the router's shared `emitEvent`. */
  emitEvent: (topic: string, payload: unknown) => void;
}

// Named-key return type (not a bare HandlerMap): under
// noUncheckedIndexedAccess a plain Record makes handlers["repos:locate"]
// resolve to `Handler | undefined` for every caller, tests included.
export function createReposHandlers(
  opts: ReposHandlerOpts,
): Record<"repos:locate", (payload: any) => Promise<any>> & HandlerMap {
  return {
    "repos:locate": async (payload) => {
      const newPath = payload?.newPath;
      if (typeof newPath !== "string" || newPath.length === 0) return { ok: false, error: "newPath-required" };
      // A supplied-but-unusable `repo` must not degrade to "unscoped": planLocate
      // would then relocate whichever lost row matches newPath.
      let repo: string | undefined;
      if (payload?.repo !== undefined) {
        const decoded = decodeRepo(payload);
        if (!decoded.ok) return decoded;
        repo = decoded.repo;
      }

      return opts.withReconcilerHeld(async () => {
        const plan = await planLocate({ newPath, repo });
        if (isRefusal(plan)) return { ok: false, error: `${plan.refusal}: ${plan.message}` };
        if (payload?.dryRun === true) return { ok: true, data: { dryRun: true, plan } };

        const result = await applyLocate(plan);
        if (!result.ok) return { ok: false, error: result.error ?? "locate-failed" };

        opts.refreshWatchedRepos();
        opts.emitEvent("repo:moved", { identity: result.identity, from: result.from, to: result.to });
        return { ok: true, data: result };
      });
    },
  };
}
