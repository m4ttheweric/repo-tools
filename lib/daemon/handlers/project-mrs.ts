/**
 * project-mrs:read — the project open-MR list for one repo, grant-gated.
 *
 * `maxAgeMs` mirrors cache:read's freshness contract (`>=` so 0 always
 * forces) but gates on listSyncedAt and awaits ONLY this repo's project
 * sync — never the full branch-enrichment refresh.
 */

import { loadRepoTracking, grants, type RepoTracking } from "../../repo-tracking.ts";
import { getProjectMRs, type ProjectMRs } from "../project-mrs-store.ts";
import { syncProjectMRs } from "../project-sync.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

/** Test seams; production callers omit this. */
export interface ProjectMRsHandlerOverrides {
  store?: ProjectMRs;
  sync?: (repoName: string) => Promise<void>;
  tracking?: () => RepoTracking;
}

export function createProjectMRsHandlers(
  ctx: HandlerContext,
  broadcast: (type: string, data: unknown) => void,
  overrides: ProjectMRsHandlerOverrides = {},
): HandlerMap {
  const store = () => overrides.store ?? getProjectMRs();
  const sync = overrides.sync
    ?? ((repoName: string) => syncProjectMRs({ repoIndex: ctx.repoIndex, broadcast }, repoName));
  const tracking = overrides.tracking ?? loadRepoTracking;
  return {
    "project-mrs:read": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const maxAgeMs = payload?.maxAgeMs as number | undefined;
      if (!repoName) return { ok: false, error: "missing repoName" };

      if (!grants(tracking(), repoName).caches.has("project-mrs")) {
        return {
          ok: false,
          error: `project-mrs cache not granted for ${repoName}; run: rt daemon track ${repoName} live branches,project-mrs`,
        };
      }

      if (typeof maxAgeMs === "number") {
        const listSyncedAt = store().read(repoName)?.listSyncedAt ?? 0;
        if (Date.now() - listSyncedAt >= maxAgeMs) {
          try {
            await sync(repoName);
          } catch (err) {
            return { ok: false, error: `project sync failed: ${String(err)}` };
          }
        }
      }

      const record = store().read(repoName);
      if (!record) return { ok: true, data: { mrs: {}, listSyncedAt: 0, source: "poll", syncedAt: 0 } };
      return {
        ok: true,
        data: { mrs: record.mrs, listSyncedAt: record.listSyncedAt, source: record.source, syncedAt: record.listSyncedAt },
      };
    },
  };
}
