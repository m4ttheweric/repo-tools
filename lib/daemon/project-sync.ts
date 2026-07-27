/**
 * Project-MR sync — resolves DEEP vs DELTA mode per repo and reconciles the
 * result into the project store. Runs from the 5-min cycle
 * (cache-refresh.ts), at watcher start (freshness.ts), and on demand from
 * project-mrs:read's maxAgeMs gate.
 *
 * Coalesced per repo: a caller arriving while a sync is in flight awaits
 * that run. This is what lets a forced read (maxAgeMs: 0) share work with
 * the cycle instead of stacking fetches — and it must NEVER fall back to
 * the full branch-enrichment refresh (spec §5.2: forced project reads may
 * not pay for unrelated repos).
 *
 * Delta-sync amendment (spec §5.7): a live rollout against a 592-MR project
 * hit GitLab resolver timeouts on the CI stages/jobs trees every 5-min
 * cycle. DEEP (unbounded, `state: opened`, list-weight fragment, full
 * paginated reconcile via `fullSync`) now only runs once per repo per
 * `DEEP_RECONCILE_MS`; the steady-state cycle runs DELTA instead
 * (`updatedAfter`-scoped, all states, list-weight, upsert-only via
 * `applyDelta`). Approval-only changes don't bump `updatedAt` and so miss
 * deltas — a documented blind spot healed by the events watcher on `live`
 * repos and by the next deep reconcile on `poll` repos.
 */

import type { PullRequest } from "@workforge/glance-sdk";
import { getRepoContext } from "./freshness.ts";
import { getProjectMRs, freshnessOf, type ProjectMRs } from "./project-mrs-store.ts";
import { getDaemonLogger } from "../daemon-logger.ts";

const log = (await getDaemonLogger()).childLogger("project-sync");

/** A repo without a record, or whose last DEEP sync is older than this, forces DEEP. */
export const DEEP_RECONCILE_MS = 24 * 60 * 60 * 1000;
/** DELTA's `updatedAfter` window is freshness minus this overlap (upserts are idempotent). */
export const DELTA_OVERLAP_MS = 2 * 60 * 1000;

export interface ProjectSyncDeps {
  repoIndex(): Record<string, string>;
  broadcast(type: string, data: unknown): void;
}

export interface ProjectSyncOverrides {
  /** Forces a mode instead of resolving it from the existing record's freshness. */
  mode?: "auto" | "deep";
  fetchProject?: (repoName: string) => Promise<{ projectPath: string; prs: PullRequest[] }>;
  fetchDelta?: (repoName: string, updatedAfter: string) => Promise<{ projectPath: string; prs: PullRequest[] }>;
  fetchSingle?: (repoName: string, projectPath: string, iid: number) => Promise<PullRequest | null>;
  store?: ProjectMRs;
}

/** Pipeline states that mean "still running" — the set the delta top-up refreshes. */
const IN_FLIGHT_PIPELINE = new Set(["running", "pending", "created", "waiting_for_resource", "preparing"]);
/** Safety cap on per-cycle pipeline top-up fetches (the set is naturally 0-5). */
export const PIPELINE_TOPUP_CAP = 15;
/** In-flight top-up fetches. Bounded so a big set can't burst the forge. */
export const TOPUP_CONCURRENCY = 4;
/**
 * MRs untouched for this long with a still-in-flight pipeline are considered
 * stuck (e.g. a pipeline sitting in "created" forever) and drop out of the
 * top-up — otherwise each one costs a heavy fetch every cycle indefinitely.
 * The daily deep reconcile still re-reads them.
 */
export const TOPUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const syncInFlight = new Map<string, Promise<void>>();

export function syncProjectMRs(
  deps: ProjectSyncDeps,
  repoName: string,
  overrides: ProjectSyncOverrides = {},
): Promise<void> {
  const existing = syncInFlight.get(repoName);
  if (existing) return existing;
  const run = syncImpl(deps, repoName, overrides).finally(() => { syncInFlight.delete(repoName); });
  syncInFlight.set(repoName, run);
  return run;
}

async function syncImpl(
  deps: ProjectSyncDeps,
  repoName: string,
  overrides: ProjectSyncOverrides,
): Promise<void> {
  const store = overrides.store ?? getProjectMRs();
  const record = store.read(repoName);

  const isDeep = overrides.mode === "deep"
    || !record
    || Date.now() - record.listSyncedAt > DEEP_RECONCILE_MS;

  if (isDeep) {
    const fetchProject = overrides.fetchProject ?? (async (repo: string) => {
      const { provider, projectPath } = await getRepoContext(repo, deps.repoIndex()[repo]);
      const prs = await provider.fetchPullRequests({ projectPath, state: "opened", listWeight: true });
      return { projectPath, prs };
    });

    const syncStartedAt = Date.now();
    const { projectPath, prs } = await fetchProject(repoName);
    const changed = store.fullSync(repoName, projectPath, prs, syncStartedAt);
    log.debug({ repo: repoName, mode: "deep", open: prs.length, changed: changed.length }, "project sync");
    if (changed.length > 0) {
      deps.broadcast("project-mrs", { repoName, iids: changed });
    }
    return;
  }

  // DELTA: updatedAfter window is this repo's read-freshness minus a
  // 2-minute overlap (upserts are idempotent, so re-covering a sliver of
  // the previous window is harmless and protects against clock skew /
  // in-flight duration).
  const deltaStartedAt = Date.now();
  const updatedAfter = new Date(freshnessOf(record) - DELTA_OVERLAP_MS).toISOString();
  const fetchDelta = overrides.fetchDelta ?? (async (repo: string, ua: string) => {
    const { provider, projectPath } = await getRepoContext(repo, deps.repoIndex()[repo]);
    const prs = await provider.fetchPullRequests({
      projectPath,
      state: ["opened", "merged", "closed"],
      updatedAfter: ua,
      listWeight: true,
    });
    return { projectPath, prs };
  });

  const { projectPath, prs } = await fetchDelta(repoName, updatedAfter);
  const changed = store.applyDelta(repoName, projectPath, prs, deltaStartedAt);

  // Pipeline top-up: pipeline transitions bump no MR timestamp, so they
  // miss deltas (same blind spot as the events feed). Refresh the MRs whose
  // STORED pipeline is still in flight and that this delta didn't already
  // cover — the set is naturally tiny (pipelines currently running on open
  // MRs), so this restores the old ≤5-min pipeline freshness for ~0-5
  // targeted fetches per cycle.
  const fetchSingle = overrides.fetchSingle ?? (async (repo: string, pp: string, iid: number) => {
    const { provider } = await getRepoContext(repo, deps.repoIndex()[repo]);
    return provider.fetchSingleMR(pp, iid, null);
  });
  const deltaIids = new Set(changed);
  const topup: number[] = [];
  const afterDelta = store.read(repoName);
  for (const [iidStr, entry] of Object.entries(afterDelta?.mrs ?? {})) {
    const iid = Number(iidStr);
    if (deltaIids.has(iid)) continue;
    if (entry.pr.state !== "opened") continue;
    const status = (entry.pr as { pipeline?: { status?: string } | null }).pipeline?.status;
    if (!status || !IN_FLIGHT_PIPELINE.has(status)) continue;
    const updatedAt = Date.parse(entry.pr.updatedAt ?? "");
    if (Number.isFinite(updatedAt) && deltaStartedAt - updatedAt > TOPUP_MAX_AGE_MS) continue;
    topup.push(iid);
    if (topup.length >= PIPELINE_TOPUP_CAP) break;
  }
  // Fetched concurrently — these are heavy per-MR detail queries, and a manual
  // refresh (maxAgeMs: 0) waits on the whole set, so a serial loop put the
  // board's spinner directly behind PIPELINE_TOPUP_CAP round trips. Upserts
  // are applied afterwards in request order so `changed` (and the broadcast it
  // feeds) stays deterministic regardless of completion order.
  const fetched: Array<PullRequest | null> = new Array(topup.length).fill(null);
  for (let i = 0; i < topup.length; i += TOPUP_CONCURRENCY) {
    const chunk = topup.slice(i, i + TOPUP_CONCURRENCY);
    await Promise.all(
      chunk.map(async (iid, j) => {
        try {
          fetched[i + j] = await fetchSingle(repoName, projectPath, iid);
        } catch (err) {
          log.warn({ err, repo: repoName, iid }, "pipeline top-up fetch failed");
        }
      }),
    );
  }
  for (const pr of fetched) {
    if (pr) changed.push(...store.upsert(repoName, projectPath, pr, "events"));
  }

  log.debug({ repo: repoName, mode: "delta", changed: changed.length, topup: topup.length }, "project sync");
  if (changed.length > 0) {
    deps.broadcast("project-mrs", { repoName, iids: changed });
  }
}
