/**
 * Doppler IPC handlers.
 *
 *   doppler:sync — run the reconciler for one repo (or all). Same logic
 *                  that runs on the daemon's cache-refresh tick.
 */

import { reconcileForRepo, type ReconcileSummary } from "../doppler-sync.ts";
import { listWorktreeRoots } from "../../git-worktrees.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

export function createDopplerHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "doppler:sync": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const repos = ctx.repoIndex();

      const targets = repoName
        ? (repos[repoName] ? [[repoName, repos[repoName]] as const] : [])
        : Object.entries(repos);

      if (targets.length === 0) {
        return { ok: false, error: repoName ? `unknown repo: ${repoName}` : "no repos registered" };
      }

      const results: Record<string, ReconcileSummary> = {};
      for (const [name, path] of targets) {
        const worktreeRoots = listWorktreeRoots(path);
        const summary = await reconcileForRepo({ repoName: name, worktreeRoots });
        results[name] = summary;
        ctx.log(`doppler:sync repo=${name} wrote=${summary.wrote} overridden=${summary.overridden} unchanged=${summary.unchanged}${summary.skipped ? ` skipped=${summary.skipped}` : ""}`);
      }

      return { ok: true, data: { results } };
    },
  };
}
