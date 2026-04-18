/**
 * Hooks-guard IPC handlers.
 *
 *   hooks:status  — return the rt hooks.json config for a repo (if any)
 *   hooks:repair  — re-apply core.hooksPath for a repo right now
 *   hooks:watch   — ensure the daemon is watching the repo's .git/config
 */

import { readFileSync } from "fs";
import { join } from "path";
import { RT_DIR } from "../../daemon-config.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

export function createHooksHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "hooks:status": async (payload) => {
      const repoName = payload?.repo;
      if (!repoName) return { ok: false, error: "missing repo" };
      const hooksJson = join(RT_DIR, repoName, "hooks.json");
      try {
        const config = JSON.parse(readFileSync(hooksJson, "utf8"));
        return { ok: true, data: config };
      } catch {
        return { ok: true, data: null };
      }
    },

    "hooks:repair": async (payload) => {
      const repoName = payload?.repo;
      if (!repoName) return { ok: false, error: "missing repo" };
      const repos = ctx.repoIndex();
      const repoPath = repos[repoName];
      if (!repoPath) return { ok: false, error: "unknown repo" };
      const repaired = ctx.checkAndRepairHooksPath(repoName, repoPath);
      return { ok: true, repaired };
    },

    "hooks:watch": async (payload) => {
      const repoName = payload?.repo;
      if (!repoName) return { ok: false, error: "missing repo" };
      const repos = ctx.repoIndex();
      const repoPath = repos[repoName];
      if (repoPath) ctx.startWatchingRepo(repoName, repoPath);
      return { ok: true };
    },
  };
}
