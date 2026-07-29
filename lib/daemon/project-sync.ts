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
 *
 * A staleness-forced deep that FAILS must not wedge the repo: `listSyncedAt`
 * never advances on failure, so without a fallback every subsequent cycle
 * re-forces the same failing deep and delta starves... the store then only
 * moves on events, which GitLab never emits for draft-to-ready. On failure
 * with an existing record, the sync falls back to delta for this cycle and
 * deep retries are held behind `DEEP_RETRY_BACKOFF_MS`. Cold starts (no
 * record to delta against) and explicit `mode: "deep"` requests still reject.
 */

import type { PullRequest } from "@workforge/glance-sdk";
import { getRepoContext, getSelfUsername, resolveSelfUsername } from "./freshness.ts";
import { getProjectMRs, freshnessOf, type ProjectMRs, type ProjectMRStore } from "./project-mrs-store.ts";
import { loadRepoTracking, grants } from "../repo-tracking.ts";
import { getDaemonLogger } from "../daemon-logger.ts";

const log = (await getDaemonLogger()).childLogger("project-sync");

/** A repo without a record, or whose last DEEP sync is older than this, forces DEEP. */
export const DEEP_RECONCILE_MS = 24 * 60 * 60 * 1000;
/** DELTA's `updatedAfter` window is freshness minus this overlap (upserts are idempotent). */
export const DELTA_OVERLAP_MS = 2 * 60 * 1000;
/** After a staleness-forced deep fails, hold deep retries this long; delta covers the gap. */
export const DEEP_RETRY_BACKOFF_MS = 60 * 60 * 1000;
/** A demand client that hasn't renewed in this long drops out of the scope on the next deep. */
export const DEMAND_IDLE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Union of every live demand's authors plus the repo's own user, sorted and
 * de-duplicated. Null means "no demands, no self" -- there is nothing to
 * scope to, so the deep sync stays the legacy unscoped project sweep.
 */
export function effectiveAuthors(record: ProjectMRStore | undefined, selfUsername: string | null): string[] | null {
  const authors = new Set<string>();
  for (const d of Object.values(record?.demands ?? {})) for (const a of d.authors) authors.add(a);
  if (selfUsername) authors.add(selfUsername);
  if (authors.size === 0) return null;
  return [...authors].sort();
}

/** Drops PRs whose updatedAt is older than the window. A missing/unparseable timestamp is kept -- never guess-drop. */
function withinWindow(prs: PullRequest[], windowDays: number, now: number): PullRequest[] {
  const cutoff = now - windowDays * 86_400_000;
  return prs.filter((pr) => {
    const t = Date.parse(pr.updatedAt ?? "");
    return !Number.isFinite(t) || t >= cutoff;
  });
}

/**
 * repoName → when a staleness-forced deep last failed. In-memory on purpose:
 * a daemon restart retrying deep immediately is the desired behavior.
 */
const deepFailedAt = new Map<string, number>();

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
  /** Scoped deep's fetch: every open MR by any of these authors. */
  fetchAuthors?: (repoName: string, authors: string[]) => Promise<{ projectPath: string; prs: PullRequest[] }>;
  /** Overrides the grants-resolved window (test seam); production always resolves it from repo-tracking. */
  windowDays?: number;
  /**
   * Test seam for the self-username resolution `syncImpl` otherwise performs
   * via `resolveSelfUsername`. `undefined` means "resolve for real"; `null`
   * means "resolved to no self" -- so passing null still opts a repo with no
   * demands into scope computation instead of the legacy unscoped sweep.
   */
  selfUsername?: string | null;
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

  const explicitDeep = overrides.mode === "deep";
  const deepDue = !record || Date.now() - record.listSyncedAt > DEEP_RECONCILE_MS;
  const deepBackingOff = Date.now() - (deepFailedAt.get(repoName) ?? 0) < DEEP_RETRY_BACKOFF_MS;
  const isDeep = explicitDeep || (deepDue && (!record || !deepBackingOff));

  if (isDeep) {
    // Idle demand clients (a board tab closed a week ago) must not keep
    // pinning their authors into the scope forever.
    store.expireDemands(repoName, DEMAND_IDLE_EXPIRY_MS);
    const windowDays = overrides.windowDays ?? grants(loadRepoTracking(), repoName).projectMrsWindowDays;

    // Resolving self costs a network round trip (via getRepoContext), so it
    // only runs when scope could actually apply: a live demand, or a caller
    // that already supplied selfUsername (test seam; `null` still counts as
    // "supplied" so it opts into scope computation instead of skipping it).
    // With neither, every existing no-demand caller (including all of
    // today's tests) stays on the legacy unscoped sweep with zero network
    // calls.
    const hasDemands = Object.keys(record?.demands ?? {}).length > 0;
    let scopeAuthors: string[] | null = null;
    if (hasDemands || overrides.selfUsername !== undefined) {
      const selfUsername = overrides.selfUsername !== undefined
        ? overrides.selfUsername
        : await resolveSelfUsername(repoName, deps.repoIndex()[repoName] ?? "");
      scopeAuthors = effectiveAuthors(record, selfUsername);
    }

    const fetchProject = overrides.fetchProject ?? (async (repo: string) => {
      const { provider, projectPath } = await getRepoContext(repo, deps.repoIndex()[repo]);
      const prs = await provider.fetchPullRequests({ projectPath, state: "opened", listWeight: true });
      return { projectPath, prs };
    });
    const fetchAuthors = overrides.fetchAuthors ?? (async (repo: string, authors: string[]) => {
      const { provider, projectPath } = await getRepoContext(repo, deps.repoIndex()[repo]);
      const prs = await provider.fetchPullRequests({ projectPath, authorUsernames: authors, state: "opened" });
      return { projectPath, prs };
    });

    const syncStartedAt = Date.now();
    try {
      if (scopeAuthors) {
        // fullSync's reconcile prunes everything absent from `kept`, which
        // now covers both out-of-scope authors and out-of-window MRs...a
        // failed author fetch rejects the whole deep (below) rather than
        // landing here as "this author has no MRs".
        const { projectPath, prs } = await fetchAuthors(repoName, scopeAuthors);
        const kept = withinWindow(prs, windowDays, syncStartedAt);
        const changed = store.fullSync(repoName, projectPath, kept, syncStartedAt);
        store.setScope(repoName, { authors: scopeAuthors, windowDays });
        deepFailedAt.delete(repoName);
        log.debug(
          { repo: repoName, mode: "deep", scoped: true, authors: scopeAuthors.length, open: kept.length, changed: changed.length },
          "project sync",
        );
        if (changed.length > 0) {
          deps.broadcast("project-mrs", { repoName, iids: changed });
        }
        return;
      }

      const { projectPath, prs } = await fetchProject(repoName);
      const changed = store.fullSync(repoName, projectPath, prs, syncStartedAt);
      // A prior deep may have left a scope from demands that have since
      // expired; landing on the unscoped sweep means that scope no longer
      // applies, and a stale one would silently misfilter every delta after
      // this point.
      store.setScope(repoName, null);
      deepFailedAt.delete(repoName);
      log.debug({ repo: repoName, mode: "deep", open: prs.length, changed: changed.length }, "project sync");
      if (changed.length > 0) {
        deps.broadcast("project-mrs", { repoName, iids: changed });
      }
      return;
    } catch (err) {
      // No record → nothing to delta against; explicit deep → the caller
      // wanted exactly this. Otherwise fall through to delta so freshness
      // keeps flowing while the heavy deep query is backing off.
      if (explicitDeep || !record) throw err;
      deepFailedAt.set(repoName, Date.now());
      log.warn({ err, repo: repoName }, "deep reconcile failed; falling back to delta");
    }
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

  let { projectPath, prs } = await fetchDelta(repoName, updatedAfter);
  // A demand-scoped repo's delta window still queries the whole project
  // (updatedAfter has no author filter), so drop anything outside scope here
  // rather than letting it back into a store the deep sync just pruned it from.
  if (record?.scope) {
    const authors = record.scope.authors;
    // A missing author is never guess-dropped (same rule as withinWindow and
    // the events-mapping upsertProject filter) -- there is no way to tell
    // which side of the scope it belongs on.
    prs = prs.filter((pr) => !pr.author?.username || authors.includes(pr.author.username));
  }
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

/**
 * On-demand top-up for authors newly added to a repo's scope (e.g. a board
 * widening its demand) without waiting for the next daily deep. Fetches only
 * the given names, upserts what's in-window, and extends (never replaces)
 * the existing scope's author list.
 */
export async function backfillAuthors(
  deps: ProjectSyncDeps,
  repoName: string,
  authors: string[],
  overrides: ProjectSyncOverrides = {},
): Promise<void> {
  // An empty list would otherwise reach store.setScope as scope.authors = [],
  // which the delta filter reads as "match nobody" -- excluding every MR on
  // a record that may already have a real scope.
  if (authors.length === 0) return;

  const store = overrides.store ?? getProjectMRs();
  const record = store.read(repoName);
  const windowDays = record?.scope?.windowDays
    ?? overrides.windowDays
    ?? grants(loadRepoTracking(), repoName).projectMrsWindowDays;
  const fetchAuthors = overrides.fetchAuthors ?? (async (repo: string, names: string[]) => {
    const { provider, projectPath } = await getRepoContext(repo, deps.repoIndex()[repo]);
    const prs = await provider.fetchPullRequests({ projectPath, authorUsernames: names, state: "opened" });
    return { projectPath, prs };
  });

  const { projectPath, prs } = await fetchAuthors(repoName, authors);
  const kept = withinWindow(prs, windowDays, Date.now());
  const changed: number[] = [];
  for (const pr of kept) {
    changed.push(...store.upsert(repoName, projectPath, pr, "events"));
  }

  // Include self so a backfill against a previously unscoped store doesn't
  // flip into scoped mode without the daemon user's own username -- that gap
  // would drop the user's own MRs from delta/events until the next deep
  // sync (up to 24h). This is a cheap in-memory read (getSelfUsername), not
  // the network resolution syncImpl does -- backfill runs on-demand from a
  // read handler and must stay cheap. undefined (production) reads the
  // cached value; null (test seam) means "resolved to no self".
  const selfUsername = overrides.selfUsername !== undefined ? overrides.selfUsername : getSelfUsername();
  const union = new Set([...(record?.scope?.authors ?? []), ...authors]);
  if (selfUsername) union.add(selfUsername);
  store.setScope(repoName, { authors: [...union].sort(), windowDays });

  if (changed.length > 0) {
    deps.broadcast("project-mrs", { repoName, iids: changed });
  }
}
