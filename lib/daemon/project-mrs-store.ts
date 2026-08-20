/**
 * Project open-MR store — the member-blind "all open MRs in the project"
 * view, one record per live/poll-tracked repo that granted "project-mrs".
 * Spec: .local-dev/2026-07-26-typed-stores-board-rewire-design.md §5.1;
 * persistence: docs/superpowers/specs/2026-08-20-rt-statedb.md "Tables
 * (v1)" (project_mrs, project_mrs_meta, project_mr_demands) and
 * "Store-by-store" item 2.
 *
 * Writers: the 5-min full sync (project-sync.ts), events-targeted upserts
 * (freshness.ts mapping), and mutation write-backs (handlers/mr.ts).
 * fullSync is a per-entry reconcile, never a blind replace, so a concurrent
 * event/mutation upsert can't be clobbered by a sync that fetched before it.
 * That reconcile now runs as ONE sqlite transaction per repo (the row writes
 * it produces commit atomically), but its visible outcome is unchanged.
 *
 * Terminal-state MRs ARE upserted (a merge must be visible instantly);
 * consumers filter by state, and the next full sync prunes them.
 *
 * RT-48: this module lives outside lib/state/ (it stays put per the task
 * brief) but registers its legacy-JSON importer the same way every
 * lib/state/ store does — imported by lib/state/index.ts for the side
 * effect, importing lib/state/db.ts directly (not the barrel) to avoid a
 * barrel <-> store import cycle. Its daemon-flavor SQLITE_BUSY handling
 * (warn-and-defer) is the shared `lib/state/busy.ts` helper (extracted from
 * this module by Task 5's orchestrator ruling, imported directly for the
 * same avoid-the-barrel-cycle reason) — see that module's doc for why its
 * logger import stays dynamic.
 */

import { Database } from "bun:sqlite";
import type { PullRequest } from "@mattstack/glance";
import { getStateDb, LEGACY_IMPORTS } from "../state/db.ts";
import { persistOrWarn } from "../state/busy.ts";

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
}

// ─── Row shapes ──────────────────────────────────────────────────────────

interface MrRow { repo: string; iid: number; pr: string; fetched_at: number; }
interface MetaRow {
  repo: string;
  list_synced_at: number;
  delta_synced_at: number | null;
  source: "poll" | "events" | "mutation";
  project_path: string;
  scope: string | null;
}
interface DemandRow { repo: string; client: string; authors: string; declared_at: number; last_seen_at: number; }

function emptyStore(projectPath: string, source: ProjectMRStore["source"] = "poll"): ProjectMRStore {
  return { projectPath, mrs: {}, listSyncedAt: 0, source };
}

function loadAll(db: Database): Record<string, ProjectMRStore> {
  const data: Record<string, ProjectMRStore> = {};

  const metaRows = db.query("SELECT repo, list_synced_at, delta_synced_at, source, project_path, scope FROM project_mrs_meta;").all() as MetaRow[];
  for (const m of metaRows) {
    data[m.repo] = {
      projectPath: m.project_path,
      mrs: {},
      listSyncedAt: m.list_synced_at,
      deltaSyncedAt: m.delta_synced_at ?? undefined,
      source: m.source,
      scope: m.scope !== null ? JSON.parse(m.scope) : undefined,
    };
  }

  const mrRows = db.query("SELECT repo, iid, pr, fetched_at FROM project_mrs;").all() as MrRow[];
  for (const r of mrRows) {
    const store = data[r.repo] ?? (data[r.repo] = emptyStore(""));
    store.mrs[r.iid] = { pr: JSON.parse(r.pr) as PullRequest, fetchedAt: r.fetched_at };
  }

  const demandRows = db.query("SELECT repo, client, authors, declared_at, last_seen_at FROM project_mr_demands;").all() as DemandRow[];
  for (const d of demandRows) {
    const store = data[d.repo] ?? (data[d.repo] = emptyStore(""));
    store.demands ??= {};
    store.demands[d.client] = { authors: JSON.parse(d.authors) as string[], declaredAt: d.declared_at, lastSeenAt: d.last_seen_at };
  }

  return data;
}

export function createProjectMRs(db: Database = getStateDb("daemon")): ProjectMRs {
  const data = loadAll(db);

  const upsertMrStmt = db.query(`
    INSERT INTO project_mrs (repo, iid, pr, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(repo, iid) DO UPDATE SET pr = excluded.pr, fetched_at = excluded.fetched_at
  `);
  const deleteMrStmt = db.query(`DELETE FROM project_mrs WHERE repo = ? AND iid = ?;`);
  const upsertMetaStmt = db.query(`
    INSERT INTO project_mrs_meta (repo, list_synced_at, delta_synced_at, source, project_path, scope)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo) DO UPDATE SET
      list_synced_at = excluded.list_synced_at,
      delta_synced_at = excluded.delta_synced_at,
      source = excluded.source,
      project_path = excluded.project_path,
      scope = excluded.scope
  `);
  const upsertDemandStmt = db.query(`
    INSERT INTO project_mr_demands (repo, client, authors, declared_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(repo, client) DO UPDATE SET
      authors = excluded.authors, declared_at = excluded.declared_at, last_seen_at = excluded.last_seen_at
  `);
  const deleteDemandStmt = db.query(`DELETE FROM project_mr_demands WHERE repo = ? AND client = ?;`);

  function writeMeta(repoName: string, store: ProjectMRStore): void {
    upsertMetaStmt.run(
      repoName,
      store.listSyncedAt,
      store.deltaSyncedAt ?? null,
      store.source,
      store.projectPath,
      store.scope ? JSON.stringify(store.scope) : null,
    );
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
    const store = existing ?? emptyStore(path, source);
    store.projectPath = path;
    const fetchedAt = Date.now();
    store.mrs[pr.iid] = { pr, fetchedAt };
    store.source = source;
    data[repoName] = store;

    persistOrWarn("project-mrs", () => {
      const run = db.transaction(() => {
        upsertMrStmt.run(repoName, pr.iid, JSON.stringify(pr), fetchedAt);
        writeMeta(repoName, store);
      });
      run();
    }, { repo: repoName, op: "upsert" });

    return [pr.iid];
  }

  function fullSync(
    repoName: string,
    projectPath: string,
    prs: PullRequest[],
    syncStartedAt: number,
  ): number[] {
    const store = data[repoName] ?? emptyStore(projectPath);
    const changed: number[] = [];
    const incoming = new Set<number>();
    const toWrite: Array<{ iid: number; pr: PullRequest; fetchedAt: number }> = [];
    const toDelete: number[] = [];

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
      toWrite.push({ iid: pr.iid, pr: toStore, fetchedAt: syncStartedAt });
    }

    for (const iidStr of Object.keys(store.mrs)) {
      const iid = Number(iidStr);
      if (incoming.has(iid)) continue;
      // (b) absent from the sync result but written AFTER the sync started:
      // an event created it mid-sync — keep it.
      if (store.mrs[iid]!.fetchedAt > syncStartedAt) continue;
      delete store.mrs[iid];
      changed.push(iid);
      toDelete.push(iid);
    }

    store.projectPath = projectPath;
    store.listSyncedAt = syncStartedAt;
    store.source = "poll";
    data[repoName] = store;

    // ONE transaction per repo: every row this reconcile touches (upserts +
    // prunes) plus the meta row commit atomically (spec "Store-by-store"
    // item 2). The reconcile ABOVE already decided what "touched" means —
    // this only persists that decision.
    persistOrWarn("project-mrs", () => {
      const run = db.transaction(() => {
        for (const w of toWrite) upsertMrStmt.run(repoName, w.iid, JSON.stringify(w.pr), w.fetchedAt);
        for (const iid of toDelete) deleteMrStmt.run(repoName, iid);
        writeMeta(repoName, store);
      });
      run();
    }, { repo: repoName, op: "fullSync" });

    return changed;
  }

  function applyDelta(
    repoName: string,
    projectPath: string,
    prs: PullRequest[],
    deltaStartedAt: number,
  ): number[] {
    const store = data[repoName] ?? emptyStore(projectPath);
    const changed: number[] = [];
    const toWrite: Array<{ iid: number; pr: PullRequest; fetchedAt: number }> = [];
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
      const fetchedAt = Date.now();
      store.mrs[pr.iid] = { pr: toStore, fetchedAt };
      changed.push(pr.iid);
      toWrite.push({ iid: pr.iid, pr: toStore, fetchedAt });
    }
    store.projectPath = projectPath;
    store.deltaSyncedAt = deltaStartedAt;
    data[repoName] = store;

    persistOrWarn("project-mrs", () => {
      const run = db.transaction(() => {
        for (const w of toWrite) upsertMrStmt.run(repoName, w.iid, JSON.stringify(w.pr), w.fetchedAt);
        writeMeta(repoName, store);
      });
      run();
    }, { repo: repoName, op: "applyDelta" });

    return changed;
  }

  // Matches any stored state (not just "opened"): callers like mr:by-branch
  // want a branch → MR resolution that mirrors what the forge itself would
  // return for `state: 'all'`, so a just-merged or closed MR is as valid a
  // cache hit as an open one. But branch names get reused (an old
  // merged/closed MR lingers until the daily deep prune, then a new MR
  // opens on the same branch name) -- an open entry is always the live
  // truth, so it wins over any terminal-state entry regardless of iid
  // order. With no open entry, the highest-iid terminal entry is the
  // newest MR on that branch name (forge 'all' semantics), not whichever
  // terminal entry Object.values happened to iterate first.
  function findBySourceBranch(repoName: string, branch: string): PullRequest | null {
    const store = data[repoName];
    if (!store) return null;
    let fallback: PullRequest | null = null;
    for (const entry of Object.values(store.mrs)) {
      if (entry.pr.sourceBranch !== branch) continue;
      if (entry.pr.state === "opened") return entry.pr;
      if (!fallback || entry.pr.iid > fallback.iid) fallback = entry.pr;
    }
    return fallback;
  }

  function registerDemand(repoName: string, client: string, authors: string[], declaredAt: number): boolean {
    const store = data[repoName] ?? (data[repoName] = emptyStore(""));
    store.demands ??= {};
    const prev = store.demands[client];
    if (prev && declaredAt < prev.declaredAt) return false;
    const unchanged = prev !== undefined
      && prev.authors.length === authors.length
      && prev.authors.every((a, i) => a === authors[i]);
    const lastSeenAt = Date.now();
    store.demands[client] = { authors: [...authors], declaredAt, lastSeenAt };

    persistOrWarn("project-mrs", () => {
      upsertDemandStmt.run(repoName, client, JSON.stringify(authors), declaredAt, lastSeenAt);
    }, { repo: repoName, op: "registerDemand" });

    return !unchanged;
  }

  function expireDemands(repoName: string, maxIdleMs: number): string[] {
    const demands = data[repoName]?.demands;
    if (!demands) return [];
    const cutoff = Date.now() - maxIdleMs;
    const dropped = Object.keys(demands).filter((c) => demands[c]!.lastSeenAt < cutoff);
    for (const c of dropped) delete demands[c];
    if (dropped.length) {
      persistOrWarn("project-mrs", () => {
        const run = db.transaction(() => {
          for (const c of dropped) deleteDemandStmt.run(repoName, c);
        });
        run();
      }, { repo: repoName, op: "expireDemands" });
    }
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
    persistOrWarn("project-mrs", () => writeMeta(repoName, store), { repo: repoName, op: "setScope" });
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
  };
}

let singleton: ProjectMRs | null = null;

export function getProjectMRs(): ProjectMRs {
  if (!singleton) singleton = createProjectMRs();
  return singleton;
}

// ─── Legacy import (project-mrs.json → project_mrs / project_mrs_meta / project_mr_demands rows) ─

interface LegacyProjectMREntry { pr?: PullRequest; fetchedAt?: number; }
interface LegacyDemandEntry { authors?: string[]; declaredAt?: number; lastSeenAt?: number; }
interface LegacyProjectMRStore {
  projectPath?: string;
  mrs?: Record<string, LegacyProjectMREntry | undefined>;
  listSyncedAt?: number;
  deltaSyncedAt?: number;
  source?: "poll" | "events" | "mutation";
  demands?: Record<string, LegacyDemandEntry | undefined>;
  scope?: { authors: string[]; windowDays: number } | null;
}

LEGACY_IMPORTS.push({
  file: "project-mrs.json",
  import: (db, json) => {
    const parsed = json as Record<string, LegacyProjectMRStore | undefined> | null;
    if (!parsed || typeof parsed !== "object") return;

    const mrStmt = db.query(`INSERT INTO project_mrs (repo, iid, pr, fetched_at) VALUES (?, ?, ?, ?);`);
    const metaStmt = db.query(`
      INSERT INTO project_mrs_meta (repo, list_synced_at, delta_synced_at, source, project_path, scope)
      VALUES (?, ?, ?, ?, ?, ?);
    `);
    const demandStmt = db.query(`INSERT INTO project_mr_demands (repo, client, authors, declared_at, last_seen_at) VALUES (?, ?, ?, ?, ?);`);

    for (const [repoName, store] of Object.entries(parsed)) {
      if (!store || typeof store !== "object") continue;

      metaStmt.run(
        repoName,
        store.listSyncedAt ?? 0,
        store.deltaSyncedAt ?? null,
        store.source ?? "poll",
        store.projectPath ?? "",
        store.scope ? JSON.stringify(store.scope) : null,
      );

      for (const [iidStr, entry] of Object.entries(store.mrs ?? {})) {
        if (!entry || entry.pr === undefined) continue;
        mrStmt.run(repoName, Number(iidStr), JSON.stringify(entry.pr), entry.fetchedAt ?? 0);
      }

      for (const [client, demand] of Object.entries(store.demands ?? {})) {
        if (!demand) continue;
        demandStmt.run(repoName, client, JSON.stringify(demand.authors ?? []), demand.declaredAt ?? 0, demand.lastSeenAt ?? 0);
      }
    }
  },
});
