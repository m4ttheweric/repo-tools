/**
 * project-mrs:read — the project open-MR list for one repo, grant-gated.
 *
 * `maxAgeMs` mirrors cache:read's freshness contract (`>=` so 0 always
 * forces) but gates on listSyncedAt and awaits ONLY this repo's project
 * sync — never the full branch-enrichment refresh.
 */

import { loadRepoTracking, grants, type RepoTracking } from "../../repo-tracking.ts";
import { getProjectMRs, freshnessOf, type ProjectMRs } from "../project-mrs-store.ts";
import { syncProjectMRs, backfillAuthors } from "../project-sync.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

/** Shape of the `demand` request field once validated. */
interface DemandRequest {
  client: string;
  authors: string[];
  declaredAt: number;
}

/** Guards store writes: a bad demand must be rejected, never partially registered. */
function isValidDemand(d: unknown): d is DemandRequest {
  if (!d || typeof d !== "object") return false;
  const { client, authors, declaredAt } = d as Record<string, unknown>;
  if (typeof client !== "string" || client.length === 0) return false;
  if (!Array.isArray(authors) || authors.length < 1 || authors.length > 200) return false;
  if (!authors.every((a) => typeof a === "string" && a.length > 0)) return false;
  if (typeof declaredAt !== "number" || !Number.isFinite(declaredAt)) return false;
  return true;
}

/** Test seams; production callers omit this. */
export interface ProjectMRsHandlerOverrides {
  store?: ProjectMRs;
  sync?: (repoName: string) => Promise<void>;
  tracking?: () => RepoTracking;
  backfill?: (repoName: string, authors: string[]) => Promise<void>;
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
  const backfill = overrides.backfill
    ?? ((repoName: string, authors: string[]) => backfillAuthors({ repoIndex: ctx.repoIndex, broadcast }, repoName, authors));
  return {
    "project-mrs:read": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const maxAgeMs = payload?.maxAgeMs as number | undefined;
      const rawDemand = payload?.demand;
      if (!repoName) return { ok: false, error: "missing repoName" };

      if (rawDemand !== undefined && !isValidDemand(rawDemand)) {
        return { ok: false, error: "malformed demand" };
      }
      const demand = rawDemand as DemandRequest | undefined;

      if (!grants(tracking(), repoName).caches.has("project-mrs")) {
        return {
          ok: false,
          error: `project-mrs cache not granted for ${repoName}; run: rt daemon track ${repoName} live branches,project-mrs`,
        };
      }

      // Registered before the freshness gate so a forced read's awaited sync
      // (below) already sees this demand's authors.
      if (demand) {
        store().registerDemand(repoName, demand.client, demand.authors, demand.declaredAt);
      }

      if (typeof maxAgeMs === "number") {
        const existing = store().read(repoName);
        const freshness = existing ? freshnessOf(existing) : 0;
        if (Date.now() - freshness >= maxAgeMs) {
          try {
            await sync(repoName);
          } catch (err) {
            return { ok: false, error: `project sync failed: ${String(err)}` };
          }
        }
      }

      let record = store().read(repoName);
      // Dedupe so a caller repeating an author doesn't double it into
      // scope.uncovered or fan out a redundant backfill fetch.
      const demandedAuthors = demand ? [...new Set(demand.authors)] : [];
      let covered = new Set(record?.scope?.authors ?? []);
      let uncovered = demandedAuthors.filter((a) => !covered.has(a));
      if (uncovered.length > 0) {
        const run = backfill(repoName, uncovered);
        if (maxAgeMs === 0) {
          await run.catch(() => {});   // forced read: caller wants completeness now
          record = store().read(repoName);
          // The backfill just extended scope.authors; recompute so a
          // completed forced read never reports an author as both covered
          // and uncovered.
          covered = new Set(record?.scope?.authors ?? []);
          uncovered = demandedAuthors.filter((a) => !covered.has(a));
        } else {
          void run.catch(() => {});    // background heal; scope.uncovered tells the client
        }
      }

      if (!record) return { ok: true, data: { mrs: {}, listSyncedAt: 0, source: "poll", syncedAt: 0 } };
      return {
        ok: true,
        data: {
          mrs: record.mrs,
          listSyncedAt: record.listSyncedAt,
          source: record.source,
          syncedAt: freshnessOf(record),
          scope: record.scope ? { ...record.scope, uncovered } : undefined,
        },
      };
    },
  };
}
