/**
 * Hooks-guard IPC handlers.
 *
 *   hooks:status  — return the rt hooks.json config for a repo (if any)
 *   hooks:repair  — re-apply core.hooksPath for a repo right now
 *   hooks:watch   — ensure the daemon is watching the repo's .git/config
 */

import { join } from "path";
import { repoDataDir } from "../../rt-paths.ts";
import { readJson } from "../../json-store.ts";
import { decodeRepo } from "../identity-decoder.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

// "hooks:repair"/"hooks:watch" are shipped rt-client commands (RT-28's CLI +
// the REST hooks-repair route); "hooks:status" has no known out-of-process
// caller and stays off the catalog (see types.ts's InternalCommands). The
// two shipped ones keep their existing flat wire replies (no `data` field)
// verbatim via the loose `Promise<any>` escape hatch, same as endpoint.ts.
export function createHooksHandlers(
  ctx: HandlerContext,
): Record<"hooks:repair" | "hooks:watch", (payload: any, signal?: AbortSignal) => Promise<any>> & HandlerMap {
  return {
    "hooks:status": async (payload) => {
      if (!(payload as { repo?: string } | undefined)?.repo) return { ok: false, error: "missing repo" };
      // The index is identity-keyed now — a bare legacy name resolves nothing.
      const decoded = decodeRepo(payload);
      if (!decoded.ok) return { ok: true, data: null };
      const repoName = decoded.repo;
      const hooksJson = join(repoDataDir(repoName), "hooks.json");
      return { ok: true, data: readJson<unknown>(hooksJson, null) };
    },

    "hooks:repair": async (payload) => {
      if (!(payload as { repo?: string } | undefined)?.repo) return { ok: false, error: "missing repo" };
      const decoded = decodeRepo(payload);
      if (!decoded.ok) return { ok: true, repaired: false };
      const repoName = decoded.repo;
      const repos = ctx.repoIndex();
      const repoPath = repos[repoName];
      if (!repoPath) return { ok: false, error: "unknown repo" };
      const repaired = await ctx.checkAndRepairHooksPath(repoName, repoPath);
      return { ok: true, repaired };
    },

    "hooks:watch": async (payload) => {
      if (!(payload as { repo?: string } | undefined)?.repo) return { ok: false, error: "missing repo" };
      const decoded = decodeRepo(payload);
      if (!decoded.ok) return { ok: true };
      const repoName = decoded.repo;
      const repos = ctx.repoIndex();
      const repoPath = repos[repoName];
      if (repoPath) ctx.startWatchingRepo(repoName, repoPath);
      return { ok: true };
    },
  };
}
