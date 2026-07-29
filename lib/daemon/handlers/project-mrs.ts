/**
 * project-mrs:read — the project open-MR list for one repo, grant-gated.
 *
 * `maxAgeMs` mirrors cache:read's freshness contract (`>=` so 0 always
 * forces) but gates on listSyncedAt and awaits ONLY this repo's project
 * sync — never the full branch-enrichment refresh.
 *
 * mr:by-branch — batch branch → MR resolution for the same repo, same grant.
 * Store-first (any stored state), forge-fallthrough on a miss with a
 * write-back upsert so the next call for that branch is a store hit. A
 * per-branch forge failure resolves to null rather than failing the batch.
 */

import type { PullRequest } from "@workforge/glance-sdk";
import { loadRepoTracking, grants, type RepoTracking } from "../../repo-tracking.ts";
import { getProjectMRs, freshnessOf, type ProjectMRs } from "../project-mrs-store.ts";
import { syncProjectMRs, backfillAuthors } from "../project-sync.ts";
import { getRepoContext } from "../freshness.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";

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

/** A malformed `branches` field never partially runs -- reject before any store or forge access. */
function isValidBranches(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 100) return false;
  return v.every((b) => typeof b === "string" && b.length > 0);
}

/** Forge fetches within a batch, mirroring project-sync.ts's pipeline top-up chunking. */
const BY_BRANCH_CONCURRENCY = 4;

/** Test seams; production callers omit this. */
export interface ProjectMRsHandlerOverrides {
  store?: ProjectMRs;
  sync?: (repoName: string) => Promise<void>;
  tracking?: () => RepoTracking;
  backfill?: (repoName: string, authors: string[]) => Promise<void>;
  /**
   * Returns projectPath explicitly alongside the PR so the write-back
   * upsert never depends on an implicit side channel (a prior version threaded
   * it through a captured outer variable, which would have silently no-opped
   * the upsert had the assignment ever been reordered out from under it).
   */
  fetchByBranch?: (repoName: string, branch: string) => Promise<{ pr: PullRequest | null; projectPath: string }>;
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
    "project-mrs:read": async (
      payload: Commands["project-mrs:read"]["payload"],
    ): Promise<{ ok: true; data: Commands["project-mrs:read"]["data"] } | { ok: false; error: string }> => {
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
      // scope.uncovered or fan out a redundant backfill fetch. Read from the
      // STORED demand for this client (not the raw request) so a stale
      // in-flight read -- one registerDemand just rejected via its monotonic
      // guard -- can't backfill authors a newer declaration already dropped.
      const demandedAuthors = demand ? [...new Set(record?.demands?.[demand.client]?.authors ?? [])] : [];
      let covered = new Set(record?.scope?.authors ?? []);
      let uncovered = demandedAuthors.filter((a) => !covered.has(a));
      if (uncovered.length > 0) {
        const attemptedAuthors = uncovered;
        const run = backfill(repoName, attemptedAuthors);
        const logBackfillFailure = (err: unknown) => {
          ctx.log.warn({ err, repo: repoName, authors: attemptedAuthors }, "backfill failed");
        };
        if (maxAgeMs === 0) {
          await run.catch(logBackfillFailure);   // forced read: caller wants completeness now
          record = store().read(repoName);
          // The backfill just extended scope.authors; recompute so a
          // completed forced read never reports an author as both covered
          // and uncovered.
          covered = new Set(record?.scope?.authors ?? []);
          uncovered = demandedAuthors.filter((a) => !covered.has(a));
        } else {
          void run.catch(logBackfillFailure);    // background heal; scope.uncovered tells the client
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

    "mr:by-branch": async (
      payload: Commands["mr:by-branch"]["payload"],
    ): Promise<{ ok: true; data: Commands["mr:by-branch"]["data"] } | { ok: false; error: string }> => {
      const repoName = payload?.repoName as string | undefined;
      const branches = payload?.branches;
      if (!repoName || !isValidBranches(branches)) {
        return { ok: false, error: "malformed by-branch request" };
      }

      if (!grants(tracking(), repoName).caches.has("project-mrs")) {
        return {
          ok: false,
          error: `project-mrs cache not granted for ${repoName}; run: rt daemon track ${repoName} live branches,project-mrs`,
        };
      }

      const byBranch: Commands["mr:by-branch"]["data"]["byBranch"] = {};
      const misses: string[] = [];
      for (const branch of branches) {
        const hit = store().findBySourceBranch(repoName, branch);
        byBranch[branch] = hit ? { pr: hit, source: "store" } : null;
        if (!hit) misses.push(branch);
      }

      // Repo context (provider + projectPath) is resolved once per
      // invocation, not once per missed branch -- every miss in this batch
      // shares the same repo. Memoized as a promise (not awaited here) so
      // concurrent misses within the first chunk all share one resolve
      // instead of racing separate getRepoContext calls.
      let repoCtxPromise: ReturnType<typeof getRepoContext> | null = null;
      const fetchByBranch = overrides.fetchByBranch ?? (async (repo: string, branch: string) => {
        repoCtxPromise ??= getRepoContext(repo, ctx.repoIndex()[repo]);
        const repoCtx = await repoCtxPromise;
        const pr = await repoCtx.provider.fetchPullRequestByBranch(repoCtx.projectPath, branch, "all");
        return { pr, projectPath: repoCtx.projectPath };
      });

      // Chunked 4-wide (mirrors project-sync.ts's pipeline top-up loop) so a
      // large batch can't burst the forge with one fetch per branch.
      for (let i = 0; i < misses.length; i += BY_BRANCH_CONCURRENCY) {
        const chunk = misses.slice(i, i + BY_BRANCH_CONCURRENCY);
        await Promise.all(chunk.map(async (branch) => {
          try {
            const { pr, projectPath } = await fetchByBranch(repoName, branch);
            if (pr) {
              store().upsert(repoName, projectPath, pr, "events");
              byBranch[branch] = { pr, source: "forge" };
            } else {
              byBranch[branch] = null;
            }
          } catch (err) {
            ctx.log.warn({ err, repo: repoName, branch }, "by-branch forge fetch failed");
            byBranch[branch] = null;
          }
        }));
      }

      const record = store().read(repoName);
      return { ok: true, data: { byBranch, syncedAt: record ? freshnessOf(record) : 0 } };
    },
  };
}
