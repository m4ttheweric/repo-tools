/**
 * Project open-MR store — the member-blind "all open MRs in the project"
 * view, one record per live/poll-tracked repo that granted "project-mrs".
 * Spec: .local-dev/2026-07-26-typed-stores-board-rewire-design.md §5.1.
 *
 * Writers: the 5-min full sync (project-sync.ts), events-targeted upserts
 * (freshness.ts mapping), and mutation write-backs (handlers/mr.ts).
 * fullSync is a per-entry reconcile, never a blind replace, so a concurrent
 * event/mutation upsert can't be clobbered by a sync that fetched before it.
 *
 * Terminal-state MRs ARE upserted (a merge must be visible instantly);
 * consumers filter by state, and the next full sync prunes them.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { PullRequest } from "@workforge/glance-sdk";
import { RT_DIR } from "../daemon-config.ts";
import { getDaemonLogger } from "../daemon-logger.ts";

const log = (await getDaemonLogger()).childLogger("project-mrs");

export const PROJECT_MRS_PATH = join(RT_DIR, "project-mrs.json");
const FLUSH_DEBOUNCE_MS = 500;

export interface ProjectMREntry { pr: PullRequest; fetchedAt: number; }
export interface DemandEntry { authors: string[]; declaredAt: number; lastSeenAt: number; }
export interface ProjectMRStore {
  projectPath: string;
  mrs: Record<number, ProjectMREntry>;
  listSyncedAt: number;
  deltaSyncedAt?: number;
  source: "poll" | "events" | "mutation";
  demands?: Record<string, DemandEntry>;
  scope?: { authors: string[]; windowDays: number };
}

/** Read freshness = the more recent of a deep sync and a delta sync (spec §5.7). */
export function freshnessOf(store: ProjectMRStore): number {
  return Math.max(store.listSyncedAt, store.deltaSyncedAt ?? 0);
}

export interface ProjectMRs {
  data: Record<string, ProjectMRStore>;
  read(repoName: string): ProjectMRStore | undefined;
  upsert(repoName: string, projectPath: string | null, pr: PullRequest, source: "events" | "mutation"): number[];
  fullSync(repoName: string, projectPath: string, prs: PullRequest[], syncStartedAt: number): number[];
  applyDelta(repoName: string, projectPath: string, prs: PullRequest[], deltaStartedAt: number): number[];
  findBySourceBranch(repoName: string, branch: string): PullRequest | null;
  registerDemand(repoName: string, client: string, authors: string[], declaredAt: number): boolean;
  expireDemands(repoName: string, maxIdleMs: number): string[];
  /** Passing null clears an existing scope (the demand that motivated it is gone). */
  setScope(repoName: string, scope: { authors: string[]; windowDays: number } | null): void;
  flushNow(): void;
}

export function createProjectMRs(
  filePath: string = PROJECT_MRS_PATH,
  flushDebounceMs: number = FLUSH_DEBOUNCE_MS,
): ProjectMRs {
  let data: Record<string, ProjectMRStore> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch { /* missing or corrupt file → cold start */ }

  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow(): void {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn({ err }, "project-mrs flush failed; continuing in-memory");
    }
  }

  // Event bursts arrive on a ~15s tick; debounce so N upserts in one tick
  // cost one disk write. flushDebounceMs=0 (tests) flushes synchronously.
  function flushSoon(): void {
    if (flushDebounceMs === 0) { flushNow(); return; }
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, flushDebounceMs);
  }

  function upsert(
    repoName: string,
    projectPath: string | null,
    pr: PullRequest,
    source: "events" | "mutation",
  ): number[] {
    const existing = data[repoName];
    const path = projectPath ?? existing?.projectPath;
    if (!path) return []; // never synced and caller has no path: no record to attach to
    const store = existing ?? { projectPath: path, mrs: {}, listSyncedAt: 0, source };
    store.projectPath = path;
    store.mrs[pr.iid] = { pr, fetchedAt: Date.now() };
    store.source = source;
    data[repoName] = store;
    flushSoon();
    return [pr.iid];
  }

  function fullSync(
    repoName: string,
    projectPath: string,
    prs: PullRequest[],
    syncStartedAt: number,
  ): number[] {
    const store = data[repoName] ?? { projectPath, mrs: {}, listSyncedAt: 0, source: "poll" as const };
    const changed: number[] = [];
    const incoming = new Set<number>();

    for (const pr of prs) {
      incoming.add(pr.iid);
      const existing = store.mrs[pr.iid];
      // (a) a concurrent event/mutation upsert is NEWER than this sync's
      // fetch — keep it; the sync result predates it.
      if (existing && existing.fetchedAt > syncStartedAt) continue;
      // (c) full syncs never carry diverged data; keep a fresher value.
      // Copy-on-preserve: callers may hold references to the same fetched
      // objects, so never mutate the incoming pr.
      const prevDiverged = (existing?.pr as { divergedCommitsCount?: number | null } | undefined)?.divergedCommitsCount;
      const incomingDiverged = (pr as { divergedCommitsCount?: number | null }).divergedCommitsCount;
      const toStore = incomingDiverged == null && prevDiverged != null
        ? ({ ...pr, divergedCommitsCount: prevDiverged } as PullRequest)
        : pr;
      store.mrs[pr.iid] = { pr: toStore, fetchedAt: syncStartedAt };
      changed.push(pr.iid);
    }

    for (const iidStr of Object.keys(store.mrs)) {
      const iid = Number(iidStr);
      if (incoming.has(iid)) continue;
      // (b) absent from the sync result but written AFTER the sync started:
      // an event created it mid-sync — keep it.
      if (store.mrs[iid]!.fetchedAt > syncStartedAt) continue;
      delete store.mrs[iid];
      changed.push(iid);
    }

    store.projectPath = projectPath;
    store.listSyncedAt = syncStartedAt;
    store.source = "poll";
    data[repoName] = store;
    flushSoon();
    return changed;
  }

  function applyDelta(
    repoName: string,
    projectPath: string,
    prs: PullRequest[],
    deltaStartedAt: number,
  ): number[] {
    const store = data[repoName] ?? { projectPath, mrs: {}, listSyncedAt: 0, source: "poll" as const };
    const changed: number[] = [];
    // Unlike fullSync, a delta is a window of updated MRs, not the whole
    // set: nothing to prune. But the same two write rules apply. An entry
    // written AFTER the delta's fetch began (event/mutation upsert racing
    // the in-flight request) is newer than anything this response carries;
    // and project-path fetches never carry diverged data, so a non-null
    // value from an event-fed fetch must survive. fetchedAt is "now" — a
    // delta result is fresher than the window start it was queried from.
    for (const pr of prs) {
      const existing = store.mrs[pr.iid];
      if (existing && existing.fetchedAt > deltaStartedAt) continue;
      const prevDiverged = (existing?.pr as { divergedCommitsCount?: number | null } | undefined)?.divergedCommitsCount;
      const incomingDiverged = (pr as { divergedCommitsCount?: number | null }).divergedCommitsCount;
      const toStore = incomingDiverged == null && prevDiverged != null
        ? ({ ...pr, divergedCommitsCount: prevDiverged } as PullRequest)
        : pr;
      store.mrs[pr.iid] = { pr: toStore, fetchedAt: Date.now() };
      changed.push(pr.iid);
    }
    store.projectPath = projectPath;
    store.deltaSyncedAt = deltaStartedAt;
    data[repoName] = store;
    flushSoon();
    return changed;
  }

  // Matches any stored state (not just "opened"): callers like mr:by-branch
  // want a branch → MR resolution that mirrors what the forge itself would
  // return for `state: 'all'`, so a just-merged or closed MR is as valid a
  // cache hit as an open one. But branch names get reused (an old
  // merged/closed MR lingers until the daily deep prune, then a new MR
  // opens on the same branch name) -- an open entry is always the live
  // truth, so it wins over any terminal-state entry regardless of iid
  // order. Only fall back to a terminal entry when no open one exists.
  function findBySourceBranch(repoName: string, branch: string): PullRequest | null {
    const store = data[repoName];
    if (!store) return null;
    let fallback: PullRequest | null = null;
    for (const entry of Object.values(store.mrs)) {
      if (entry.pr.sourceBranch !== branch) continue;
      if (entry.pr.state === "opened") return entry.pr;
      fallback ??= entry.pr;
    }
    return fallback;
  }

  function registerDemand(repoName: string, client: string, authors: string[], declaredAt: number): boolean {
    const store = data[repoName]
      ?? (data[repoName] = { projectPath: "", mrs: {}, listSyncedAt: 0, source: "poll" as const });
    store.demands ??= {};
    const prev = store.demands[client];
    if (prev && declaredAt < prev.declaredAt) return false;
    const unchanged = prev !== undefined
      && prev.authors.length === authors.length
      && prev.authors.every((a, i) => a === authors[i]);
    store.demands[client] = { authors: [...authors], declaredAt, lastSeenAt: Date.now() };
    flushSoon();
    return !unchanged;
  }

  function expireDemands(repoName: string, maxIdleMs: number): string[] {
    const demands = data[repoName]?.demands;
    if (!demands) return [];
    const cutoff = Date.now() - maxIdleMs;
    const dropped = Object.keys(demands).filter((c) => demands[c]!.lastSeenAt < cutoff);
    for (const c of dropped) delete demands[c];
    if (dropped.length) flushSoon();
    return dropped;
  }

  function setScope(repoName: string, scope: { authors: string[]; windowDays: number } | null): void {
    const store = data[repoName];
    if (!store) return;
    if (scope === null) {
      delete store.scope;
    } else {
      store.scope = { authors: [...scope.authors], windowDays: scope.windowDays };
    }
    flushSoon();
  }

  return {
    data,
    read: (repoName) => data[repoName],
    upsert,
    fullSync,
    applyDelta,
    findBySourceBranch,
    registerDemand,
    expireDemands,
    setScope,
    flushNow,
  };
}

let singleton: ProjectMRs | null = null;

export function getProjectMRs(): ProjectMRs {
  if (!singleton) singleton = createProjectMRs();
  return singleton;
}
