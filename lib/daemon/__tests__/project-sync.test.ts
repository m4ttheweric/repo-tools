import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { syncProjectMRs, backfillAuthors, backfillSections, effectiveSections, sectionsMatching, DEEP_RECONCILE_MS, DEEP_RETRY_BACKOFF_MS, DELTA_OVERLAP_MS } from "../project-sync.ts";
import { createProjectMRs } from "../project-mrs-store.ts";
import { openStateDb } from "../../state/index.ts";
import type { PullRequest } from "@mattstack/glance";

function pr(iid: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `gitlab:mr:${iid}`, iid, title: `MR ${iid}`, state: "opened",
    sourceBranch: `b${iid}`, targetBranch: "main", webUrl: "", divergedCommitsCount: null,
    ...over,
  } as unknown as PullRequest;
}
// RT-48: project-mrs persistence moved off project-mrs.json to state.db —
// fresh temp db per call, same isolation the old file-path helper had.
function tmpStore() {
  return createProjectMRs(openStateDb(join(mkdtempSync(join(tmpdir(), "rt-psync-")), "state.db"), "cli"));
}

describe("syncProjectMRs", () => {
  test("fetches, fullSyncs, broadcasts slim payload", async () => {
    const store = tmpStore();
    const events: Array<{ type: string; data: any }> = [];
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: (type, data) => events.push({ type, data }) },
      "repo",
      { store, fetchProject: async () => ({ projectPath: "g/p", prs: [pr(1), pr(2)] }) },
    );
    expect(Object.keys(store.read("repo")!.mrs).sort()).toEqual(["1", "2"]);
    expect(events).toEqual([{ type: "project-mrs", data: { repoName: "repo", iids: [1, 2] } }]);
  });

  test("no changes → no broadcast", async () => {
    const store = tmpStore();
    const deps = { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => { throw new Error("must not broadcast"); } };
    const fetchProject = async () => ({ projectPath: "g/p", prs: [pr(1)] });
    await syncProjectMRs({ ...deps, broadcast: () => {} }, "repo", { store, fetchProject });
    // Second sync with identical content still rewrites entries (fetchedAt <= started is stale),
    // so "no changes" means an empty project staying empty:
    const store2 = tmpStore();
    await syncProjectMRs(deps, "repo", { store: store2, fetchProject: async () => ({ projectPath: "g/p", prs: [] }) });
  });

  test("concurrent callers coalesce to one fetch", async () => {
    const store = tmpStore();
    let fetches = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchProject = async () => { fetches++; await gate; return { projectPath: "g/p", prs: [pr(1)] }; };
    const deps = { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} };
    const p1 = syncProjectMRs(deps, "repo", { store, fetchProject });
    const p2 = syncProjectMRs(deps, "repo", { store, fetchProject });
    release();
    await Promise.all([p1, p2]);
    expect(fetches).toBe(1);
  });

  test("fetch failure logs and rejects without corrupting the store", async () => {
    const store = tmpStore();
    const deps = { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} };
    await expect(
      syncProjectMRs(deps, "repo", { store, fetchProject: async () => { throw new Error("gitlab down"); } }),
    ).rejects.toThrow("gitlab down");
    expect(store.read("repo")).toBeUndefined();
  });
});

describe("mode resolution", () => {
  test("no record → deep fetch called, delta never called", async () => {
    const store = tmpStore();
    let deepCalled = false;
    let deltaCalled = false;
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      {
        store,
        fetchProject: async () => { deepCalled = true; return { projectPath: "g/p", prs: [pr(1)] }; },
        fetchDelta: async () => { deltaCalled = true; return { projectPath: "g/p", prs: [] }; },
      },
    );
    expect(deepCalled).toBe(true);
    expect(deltaCalled).toBe(false);
  });

  test("fresh record → delta fetch called with updatedAfter ≈ freshness - 2min", async () => {
    const store = tmpStore();
    const listSyncedAt = Date.now() - 30_000; // recent, well under the 24h deep threshold
    store.fullSync("repo", "g/p", [pr(1)], listSyncedAt);
    let deepCalled = false;
    let capturedUpdatedAfter: string | undefined;
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      {
        store,
        fetchProject: async () => { deepCalled = true; return { projectPath: "g/p", prs: [] }; },
        fetchDelta: async (_repo, updatedAfter) => { capturedUpdatedAfter = updatedAfter; return { projectPath: "g/p", prs: [] }; },
      },
    );
    expect(deepCalled).toBe(false);
    expect(capturedUpdatedAfter).toBeDefined();
    const expected = listSyncedAt - DELTA_OVERLAP_MS;
    const actual = new Date(capturedUpdatedAfter!).getTime();
    expect(Math.abs(actual - expected)).toBeLessThan(2000); // tolerance for wall-clock drift during the test
  });

  test("listSyncedAt older than 24h → deep, even though a record exists", async () => {
    const store = tmpStore();
    const listSyncedAt = Date.now() - (DEEP_RECONCILE_MS + 60_000);
    store.fullSync("repo", "g/p", [pr(1)], listSyncedAt);
    let deepCalled = false;
    let deltaCalled = false;
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      {
        store,
        fetchProject: async () => { deepCalled = true; return { projectPath: "g/p", prs: [] }; },
        fetchDelta: async () => { deltaCalled = true; return { projectPath: "g/p", prs: [] }; },
      },
    );
    expect(deepCalled).toBe(true);
    expect(deltaCalled).toBe(false);
  });

  test("explicit mode: 'deep' forces deep even with a fresh record", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [pr(1)], Date.now() - 1000);
    let deepCalled = false;
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      {
        store,
        mode: "deep",
        fetchProject: async () => { deepCalled = true; return { projectPath: "g/p", prs: [] }; },
        fetchDelta: async () => { throw new Error("must not call delta"); },
      },
    );
    expect(deepCalled).toBe(true);
  });

  test("delta upserts via applyDelta, bumps deltaSyncedAt not listSyncedAt, and broadcasts on changed", async () => {
    const store = tmpStore();
    const listSyncedAt = Date.now() - 1000;
    store.fullSync("repo", "g/p", [pr(1)], listSyncedAt);
    const events: Array<{ type: string; data: any }> = [];
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: (type, data) => events.push({ type, data }) },
      "repo",
      { store, fetchDelta: async () => ({ projectPath: "g/p", prs: [pr(2, { state: "merged" })] }) },
    );
    expect(events).toEqual([{ type: "project-mrs", data: { repoName: "repo", iids: [2] } }]);
    expect(store.read("repo")!.mrs[2]!.pr.state).toBe("merged");
    expect(store.read("repo")!.mrs[1]).toBeDefined(); // delta doesn't prune
    expect(store.read("repo")!.listSyncedAt).toBe(listSyncedAt); // untouched
    expect(store.read("repo")!.deltaSyncedAt).toBeGreaterThanOrEqual(listSyncedAt);
  });

  test("delta with no changes → no broadcast", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [pr(1)], Date.now() - 1000);
    const deps = { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => { throw new Error("must not broadcast"); } };
    await syncProjectMRs(deps, "repo", { store, fetchDelta: async () => ({ projectPath: "g/p", prs: [] }) });
  });

  test("deep still prunes via fullSync", async () => {
    const store = tmpStore();
    const listSyncedAt = Date.now() - (DEEP_RECONCILE_MS + 60_000);
    store.fullSync("repo", "g/p", [pr(1), pr(2)], listSyncedAt); // forces deep mode below
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      { store, fetchProject: async () => ({ projectPath: "g/p", prs: [pr(1)] }) }, // pr 2 no longer open
    );
    expect(store.read("repo")!.mrs[1]).toBeDefined();
    expect(store.read("repo")!.mrs[2]).toBeUndefined();
  });
});


/**
 * Narrowers for the typed handler results (MAT-31): the handlers now return
 * the catalog's discriminated union, so reaching for `.data`/`.error`
 * without deciding which arm you expect is a type error. Throwing on the
 * wrong arm keeps the failure message better than a bare undefined access.
 */
function dataOf<T>(res: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!res.ok) throw new Error(`expected ok:true, got error: ${res.error}`);
  return res.data;
}
function errOf<T>(res: { ok: true; data: T } | { ok: false; error: string }): string {
  if (res.ok) throw new Error(`expected ok:false, got data: ${JSON.stringify(res.data)}`);
  return res.error;
}

describe("project-mrs:read handler", async () => {
  const { createProjectMRsHandlers } = await import("../handlers/project-mrs.ts");
  const fakeCtx = { repoIndex: () => ({ "remote:repo": "/tmp/repo" }), log: { warn: () => {} } } as any;
  const grantedTracking = () => ({ "remote:repo": { mode: "live" as const, caches: ["branches", "project-mrs"] as any } });

  test("grant denied → instructive error, sync never runs", async () => {
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store: tmpStore(), sync: async () => { synced++; }, tracking: () => ({}),
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo" });
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("project-mrs cache not granted for remote:repo");
    expect(errOf(res)).toContain("rt daemon track remote:repo live branches,project-mrs");
    expect(synced).toBe(0);
  });

  test("maxAgeMs 0 always forces the per-repo sync; fresh store skips it", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [pr(1)], Date.now());     // listSyncedAt ≈ now
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => { synced++; }, tracking: grantedTracking,
    });
    await h["project-mrs:read"]!({ repoName: "remote:repo", maxAgeMs: 60_000 });  // fresh → no sync
    expect(synced).toBe(0);
    await h["project-mrs:read"]!({ repoName: "remote:repo", maxAgeMs: 0 });       // 0 → forces
    expect(synced).toBe(1);
  });

  test("no maxAgeMs → serve whatever the store has; empty store → empty shape", async () => {
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store: tmpStore(), sync: async () => { synced++; }, tracking: grantedTracking,
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo" });
    expect(res.ok).toBe(true);
    expect(dataOf(res)).toEqual({ mrs: {}, listSyncedAt: 0, source: "poll", syncedAt: 0 });
    expect(synced).toBe(0);
  });

  test("reads under a serialized repo identity — grants, store, and sync all key on the same value", async () => {
    const identity = "remote:gitlab.com%2Facme%2Fr";
    const store = tmpStore();
    store.fullSync(identity, "g/p", [pr(1)], Date.now());
    const idCtx = { repoIndex: () => ({ [identity]: "/tmp/repo" }), log: { warn: () => {} } } as any;
    const idTracking = () => ({ [identity]: { mode: "live" as const, caches: ["branches", "project-mrs"] as any } });
    let synced = 0;
    const h = createProjectMRsHandlers(idCtx, () => {}, {
      store, sync: async () => { synced++; }, tracking: idTracking,
    });
    const res = await h["project-mrs:read"]!({ repoName: identity });
    expect(res.ok).toBe(true);
    expect(Object.keys(dataOf(res).mrs)).toEqual(["1"]);
    expect(synced).toBe(0); // fresh store, no maxAgeMs → no forced sync
  });

  test("sync failure surfaces as an error, not a crash", async () => {
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store: tmpStore(), sync: async () => { throw new Error("boom"); }, tracking: grantedTracking,
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo", maxAgeMs: 0 });
    expect(res.ok).toBe(false);
    expect(errOf(res)).toContain("project sync failed");
  });

  test("freshness gate honors deltaSyncedAt: old listSyncedAt but fresh deltaSyncedAt → no sync", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [pr(1)], Date.now() - 10 * 60_000); // stale as a deep sync
    store.applyDelta("remote:repo", "g/p", [pr(1)], Date.now());             // but delta-fresh
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => { synced++; }, tracking: grantedTracking,
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo", maxAgeMs: 60_000 });
    expect(synced).toBe(0);
    expect(res.ok).toBe(true);
    expect(dataOf(res).syncedAt).toBe(store.read("remote:repo")!.deltaSyncedAt!);
  });

  test("demand registers before the freshness gate and is monotonic", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now());
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store, sync: async () => {}, tracking: grantedTracking });
    await h["project-mrs:read"]!({ repoName: "remote:repo", demand: { client: "b:1", authors: ["x"], declaredAt: 5 } });
    await h["project-mrs:read"]!({ repoName: "remote:repo", demand: { client: "b:1", authors: ["stale"], declaredAt: 4 } });
    expect(store.read("remote:repo")!.demands!["b:1"]!.authors).toEqual(["x"]);
  });

  test("malformed demand is rejected without registering", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now());
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store, sync: async () => {}, tracking: grantedTracking });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo", demand: { client: "", authors: ["x"], declaredAt: 1 } });
    expect(res.ok).toBe(false);
    expect(store.read("remote:repo")!.demands).toBeUndefined();
  });

  test("uncovered demanded authors are reported and kick a backfill on unforced reads", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now());
    store.setScope("remote:repo", { authors: ["alice"], windowDays: 30 });
    const backfilled: string[][] = [];
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => {}, tracking: grantedTracking,
      backfill: async (_r, authors) => { backfilled.push(authors); },
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo",
      demand: { client: "b:1", authors: ["alice", "newbie"], declaredAt: 1 } });
    expect(res.ok).toBe(true);
    expect((dataOf(res) as any).scope).toEqual({ authors: ["alice"], windowDays: 30, uncovered: ["newbie"] });
    await new Promise((r) => setTimeout(r, 0));   // fire-and-forget settles
    expect(backfilled).toEqual([["newbie"]]);
  });

  test("forced read with uncovered authors awaits the backfill", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now() - 60_000);
    store.setScope("remote:repo", { authors: [], windowDays: 30 });
    const order: string[] = [];
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => { order.push("sync"); }, tracking: grantedTracking,
      backfill: async () => { order.push("backfill"); },
    });
    await h["project-mrs:read"]!({ repoName: "remote:repo", maxAgeMs: 0,
      demand: { client: "b:1", authors: ["newbie"], declaredAt: 1 } });
    expect(order).toEqual(["sync", "backfill"]);
  });

  test("forced read recomputes uncovered after the backfill completes", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now() - 60_000);
    store.setScope("remote:repo", { authors: ["alice"], windowDays: 30 });
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => {}, tracking: grantedTracking,
      // Mirrors what the real backfillAuthors does: extends the stored scope
      // with the authors it just fetched.
      backfill: async (_r, authors) => {
        const existing = store.read("remote:repo")!.scope!.authors;
        store.setScope("remote:repo", { authors: [...existing, ...authors].sort(), windowDays: 30 });
      },
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo", maxAgeMs: 0,
      demand: { client: "b:1", authors: ["alice", "newbie"], declaredAt: 1 } });
    expect(res.ok).toBe(true);
    expect((dataOf(res) as any).scope.uncovered).toEqual([]);
    expect((dataOf(res) as any).scope.authors).toContain("newbie");
  });

  test("duplicate demanded authors collapse to a single uncovered entry", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now());
    store.setScope("remote:repo", { authors: ["alice"], windowDays: 30 });
    const backfilled: string[][] = [];
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => {}, tracking: grantedTracking,
      backfill: async (_r, authors) => { backfilled.push(authors); },
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo",
      demand: { client: "b:1", authors: ["alice", "newbie", "newbie"], declaredAt: 1 } });
    expect((dataOf(res) as any).scope.uncovered).toEqual(["newbie"]);
    await new Promise((r) => setTimeout(r, 0));   // fire-and-forget settles
    expect(backfilled).toEqual([["newbie"]]);
  });

  test("background backfill rejection is logged at warn, not silently swallowed (finding 2)", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now());
    store.setScope("remote:repo", { authors: ["alice"], windowDays: 30 });
    const warns: Array<{ obj: any; msg: string }> = [];
    const ctxWithLog = { ...fakeCtx, log: { warn: (obj: any, msg: string) => warns.push({ obj, msg }) } };
    const h = createProjectMRsHandlers(ctxWithLog, () => {}, {
      store, sync: async () => {}, tracking: grantedTracking,
      backfill: async () => { throw new Error("gitlab down"); },
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo",
      demand: { client: "b:1", authors: ["alice", "newbie"], declaredAt: 1 } });
    expect(res.ok).toBe(true); // unforced read still succeeds -- existing behavior
    await new Promise((r) => setTimeout(r, 0));   // fire-and-forget settles
    expect(warns.length).toBe(1);
    expect(warns[0]!.obj.repo).toBe("remote:repo");
    expect(warns[0]!.obj.authors).toEqual(["newbie"]);
    expect(warns[0]!.obj.err).toBeInstanceOf(Error);
  });

  test("forced backfill rejection is logged at warn and the read still resolves ok (finding 2)", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now() - 60_000);
    store.setScope("remote:repo", { authors: ["alice"], windowDays: 30 });
    const warns: Array<{ obj: any; msg: string }> = [];
    const ctxWithLog = { ...fakeCtx, log: { warn: (obj: any, msg: string) => warns.push({ obj, msg }) } };
    const h = createProjectMRsHandlers(ctxWithLog, () => {}, {
      store, sync: async () => {}, tracking: grantedTracking,
      backfill: async () => { throw new Error("gitlab down"); },
    });
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo", maxAgeMs: 0,
      demand: { client: "b:1", authors: ["alice", "newbie"], declaredAt: 1 } });
    expect(res.ok).toBe(true);
    expect(warns.length).toBe(1);
    expect(warns[0]!.obj.repo).toBe("remote:repo");
    expect(warns[0]!.obj.authors).toEqual(["newbie"]);
  });

  test("uncovered is computed from the stored demand, not a stale request (finding 4)", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now());
    store.setScope("remote:repo", { authors: [], windowDays: 30 });
    const backfilled: string[][] = [];
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => {}, tracking: grantedTracking,
      backfill: async (_r, authors) => { backfilled.push(authors); },
    });
    // A newer demand declares "new" for client b:1.
    await h["project-mrs:read"]!({ repoName: "remote:repo",
      demand: { client: "b:1", authors: ["new"], declaredAt: 200 } });
    backfilled.length = 0;
    // A stale in-flight read for the same client arrives after and is
    // rejected by registerDemand's monotonic guard -- the stored demand for
    // b:1 stays ["new"], and uncovered/backfill must reflect that, not the
    // stale request's ["old"].
    const res = await h["project-mrs:read"]!({ repoName: "remote:repo",
      demand: { client: "b:1", authors: ["old"], declaredAt: 100 } });
    expect(store.read("remote:repo")!.demands!["b:1"]!.authors).toEqual(["new"]); // unchanged by the stale demand
    expect(res.ok).toBe(true);
    expect((dataOf(res) as any).scope.uncovered).toEqual(["new"]);
    await new Promise((r) => setTimeout(r, 0));   // fire-and-forget settles
    expect(backfilled).toEqual([["new"]]);
  });

  test("by-branch: store hit wins with source store", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [pr(1, { sourceBranch: "feat-a" })], Date.now());
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store, sync: async () => {}, tracking: grantedTracking,
      fetchByBranch: async () => { throw new Error("must not hit forge"); } });
    const res = await h["mr:by-branch"]!({ repoName: "remote:repo", branches: ["feat-a"] });
    expect(res.ok).toBe(true);
    expect((dataOf(res) as any).byBranch["feat-a"]).toMatchObject({ source: "store", pr: { iid: 1 } });
  });

  test("by-branch: miss falls through to forge, writes back, next call is a store hit", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [], Date.now());
    let forgeCalls = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store, sync: async () => {}, tracking: grantedTracking,
      fetchByBranch: async (_r, branch) => { forgeCalls++; return { pr: pr(7, { sourceBranch: branch, state: "merged" }), projectPath: "g/p" }; } });
    const r1 = await h["mr:by-branch"]!({ repoName: "remote:repo", branches: ["feat-b"] });
    expect((dataOf(r1) as any).byBranch["feat-b"].source).toBe("forge");
    const r2 = await h["mr:by-branch"]!({ repoName: "remote:repo", branches: ["feat-b"] });
    expect((dataOf(r2) as any).byBranch["feat-b"].source).toBe("store");
    expect(forgeCalls).toBe(1);
  });

  test("by-branch: no MR anywhere is null; a per-branch forge failure is null with a warn, not a batch failure", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [pr(1, { sourceBranch: "ok" })], Date.now());
    const warns: any[] = [];
    const ctx = { ...fakeCtx, log: { ...fakeCtx.log, warn: (o: any) => warns.push(o) } } as any;
    const h = createProjectMRsHandlers(ctx, () => {}, { store, sync: async () => {}, tracking: grantedTracking,
      fetchByBranch: async (_r, branch) => { if (branch === "boom") throw new Error("forge down"); return { pr: null, projectPath: "g/p" }; } });
    const res = await h["mr:by-branch"]!({ repoName: "remote:repo", branches: ["ok", "gone", "boom"] });
    expect(res.ok).toBe(true);
    expect((dataOf(res) as any).byBranch["ok"].source).toBe("store");
    expect((dataOf(res) as any).byBranch["gone"]).toBeNull();
    expect((dataOf(res) as any).byBranch["boom"]).toBeNull();
    expect(warns.length).toBe(1);
  });

  test("by-branch: malformed requests and missing grant are rejected", async () => {
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store: tmpStore(), sync: async () => {}, tracking: grantedTracking });
    expect((await h["mr:by-branch"]!({ repoName: "remote:repo", branches: [] })).ok).toBe(false);
    expect((await h["mr:by-branch"]!({ repoName: "remote:repo", branches: Array.from({length: 101}, (_, i) => `b${i}`) })).ok).toBe(false);
    const denied = createProjectMRsHandlers(fakeCtx, () => {}, { store: tmpStore(), sync: async () => {}, tracking: () => ({}) });
    expect(errOf(await denied["mr:by-branch"]!({ repoName: "remote:repo", branches: ["x"] }))).toContain("not granted");
  });

  test("Hard cutover: a bare legacy repoName resolves nothing rather than name-matching, on both verbs", async () => {
    const store = tmpStore();
    store.fullSync("remote:repo", "g/p", [pr(1, { sourceBranch: "feat-a" })], Date.now());
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store, sync: async () => {}, tracking: grantedTracking });

    const read = await h["project-mrs:read"]!({ repoName: "repo" });
    expect(read).toEqual({ ok: true, data: { mrs: {}, listSyncedAt: 0, source: "poll", syncedAt: 0 } });

    const byBranch = await h["mr:by-branch"]!({ repoName: "repo", branches: ["feat-a"] });
    expect(byBranch).toEqual({ ok: true, data: { byBranch: {}, syncedAt: 0 } });
  });
});

describe("deep-failure fallback (wedged-repo fix)", () => {
  const overdue = () => Date.now() - (DEEP_RECONCILE_MS + 60_000);

  test("staleness-forced deep that fails falls back to delta in the same sync", async () => {
    const store = tmpStore();
    store.fullSync("wedge-a", "g/p", [pr(1, { title: "Draft: MR 1" })], overdue());
    const events: Array<{ type: string; data: any }> = [];
    await syncProjectMRs(
      { repoIndex: () => ({ "wedge-a": "/tmp/repo" }), broadcast: (type, data) => events.push({ type, data }) },
      "wedge-a",
      {
        store,
        fetchProject: async () => { throw new Error("GraphQL errors: Timeout on DiffStatsSummary.additions"); },
        fetchDelta: async () => ({ projectPath: "g/p", prs: [pr(1, { title: "MR 1" })] }),
      },
    );
    expect(store.read("wedge-a")!.mrs[1]!.pr.title).toBe("MR 1");
    expect(store.read("wedge-a")!.deltaSyncedAt).toBeGreaterThan(overdue());
    expect(events).toEqual([{ type: "project-mrs", data: { repoName: "wedge-a", iids: [1] } }]);
  });

  test("a failed deep backs off: the next overdue sync goes straight to delta", async () => {
    const store = tmpStore();
    store.fullSync("wedge-b", "g/p", [pr(1)], overdue());
    const deps = { repoIndex: () => ({ "wedge-b": "/tmp/repo" }), broadcast: () => {} };
    let deepAttempts = 0;
    const failingDeep = async () => { deepAttempts++; throw new Error("still timing out"); };
    const opts = { store, fetchProject: failingDeep, fetchDelta: async () => ({ projectPath: "g/p", prs: [] }) };

    await syncProjectMRs(deps, "wedge-b", opts);
    expect(deepAttempts).toBe(1);
    // listSyncedAt is still overdue, but the backoff routes this one to delta.
    await syncProjectMRs(deps, "wedge-b", opts);
    expect(deepAttempts).toBe(1);
  });

  test("backoff expires: deep is retried after DEEP_RETRY_BACKOFF_MS", async () => {
    const store = tmpStore();
    store.fullSync("wedge-c", "g/p", [pr(1)], overdue());
    const deps = { repoIndex: () => ({ "wedge-c": "/tmp/repo" }), broadcast: () => {} };
    let deepAttempts = 0;
    const opts = {
      store,
      fetchProject: async () => { deepAttempts++; throw new Error("still timing out"); },
      fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
    };
    try {
      await syncProjectMRs(deps, "wedge-c", opts);
      expect(deepAttempts).toBe(1);
      setSystemTime(new Date(Date.now() + DEEP_RETRY_BACKOFF_MS + 60_000));
      await syncProjectMRs(deps, "wedge-c", opts);
      expect(deepAttempts).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("deep success clears the backoff clock via listSyncedAt", async () => {
    const store = tmpStore();
    store.fullSync("wedge-d", "g/p", [pr(1)], overdue());
    const deps = { repoIndex: () => ({ "wedge-d": "/tmp/repo" }), broadcast: () => {} };
    await syncProjectMRs(deps, "wedge-d", {
      store,
      fetchProject: async () => { throw new Error("timeout"); },
      fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
    });
    // Deep succeeds on the backoff retry → listSyncedAt advances → next sync is plain delta.
    setSystemTime(new Date(Date.now() + DEEP_RETRY_BACKOFF_MS + 60_000));
    try {
      await syncProjectMRs(deps, "wedge-d", { store, fetchProject: async () => ({ projectPath: "g/p", prs: [pr(1)] }), fetchDelta: async () => { throw new Error("must not delta"); } });
      let deepCalled = false;
      await syncProjectMRs(deps, "wedge-d", {
        store,
        fetchProject: async () => { deepCalled = true; return { projectPath: "g/p", prs: [] }; },
        fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
      });
      expect(deepCalled).toBe(false);
    } finally {
      setSystemTime();
    }
  });

  test("cold start (no record) deep failure still rejects: nothing to delta against", async () => {
    const store = tmpStore();
    await expect(
      syncProjectMRs(
        { repoIndex: () => ({ "wedge-e": "/tmp/repo" }), broadcast: () => {} },
        "wedge-e",
        { store, fetchProject: async () => { throw new Error("gitlab down"); }, fetchDelta: async () => ({ projectPath: "g/p", prs: [] }) },
      ),
    ).rejects.toThrow("gitlab down");
  });

  test("explicit mode:'deep' failure still rejects: the caller asked for deep", async () => {
    const store = tmpStore();
    store.fullSync("wedge-f", "g/p", [pr(1)], Date.now() - 1000);
    await expect(
      syncProjectMRs(
        { repoIndex: () => ({ "wedge-f": "/tmp/repo" }), broadcast: () => {} },
        "wedge-f",
        { store, mode: "deep", fetchProject: async () => { throw new Error("timeout"); }, fetchDelta: async () => ({ projectPath: "g/p", prs: [] }) },
      ),
    ).rejects.toThrow("timeout");
  });
});

describe("pipeline top-up (delta blind-spot fix)", () => {
  const prWithPipe = (iid: number, status: string | null, state = "opened") =>
    ({ id: `gitlab:mr:${iid}`, iid, title: `MR ${iid}`, state, sourceBranch: `b${iid}`, targetBranch: "main",
       webUrl: "", divergedCommitsCount: null, pipeline: status ? { status } : null }) as any;

  test("delta refreshes in-flight-pipeline MRs the window missed; settled/closed skipped", async () => {
    const store = tmpStore();
    const t0 = Date.now() - 10_000;
    store.fullSync("repo", "g/p", [
      prWithPipe(1, "running"),          // in flight -> top-up
      prWithPipe(2, "success"),          // settled -> skip
      prWithPipe(3, "pending", "merged"),// not opened -> skip
      prWithPipe(4, null),               // no pipeline -> skip
      prWithPipe(5, "created"),          // in flight but covered by delta below -> skip
    ], t0);
    const singles: number[] = [];
    const events: any[] = [];
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: (t, d) => events.push(d) },
      "repo",
      {
        store,
        fetchDelta: async () => ({ projectPath: "g/p", prs: [prWithPipe(5, "success")] }),
        fetchSingle: async (_r, _pp, iid) => { singles.push(iid); return prWithPipe(iid, "success"); },
      },
    );
    expect(singles).toEqual([1]);
    expect((store.read("repo")!.mrs[1]!.pr as any).pipeline.status).toBe("success");
    expect((events.at(-1) as any).iids).toContain(1);
  });

  test("top-up fetches run concurrently — a serial loop stalls the manual refresh", async () => {
    const store = tmpStore();
    const many = Array.from({ length: 8 }, (_, i) => prWithPipe(i + 1, "running"));
    store.fullSync("repo", "g/p", many, Date.now() - 10_000);

    let inFlight = 0;
    let peak = 0;
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      {
        store,
        fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
        fetchSingle: async (_r, _pp, iid) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return prWithPipe(iid, "success");
        },
      },
    );

    expect(peak).toBeGreaterThan(1);
    // Every one still lands, regardless of completion order.
    for (let iid = 1; iid <= 8; iid++) {
      expect((store.read("repo")!.mrs[iid]!.pr as any).pipeline.status).toBe("success");
    }
  });

  test("top-up applies upserts in request order, so `changed` stays deterministic", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [1, 2, 3, 4].map((i) => prWithPipe(i, "running")), Date.now() - 10_000);
    const events: any[] = [];
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: (_t, d) => events.push(d) },
      "repo",
      {
        store,
        fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
        // Resolve in reverse order: later iids finish first.
        fetchSingle: async (_r, _pp, iid) => {
          await new Promise((r) => setTimeout(r, (5 - iid) * 4));
          return prWithPipe(iid, "success");
        },
      },
    );
    expect((events.at(-1) as any).iids).toEqual([1, 2, 3, 4]);
  });

  test("one failing top-up fetch does not sink the rest", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [1, 2, 3].map((i) => prWithPipe(i, "running")), Date.now() - 10_000);
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      {
        store,
        fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
        fetchSingle: async (_r, _pp, iid) => {
          if (iid === 2) throw new Error("gitlab said no");
          return prWithPipe(iid, "success");
        },
      },
    );
    expect((store.read("repo")!.mrs[1]!.pr as any).pipeline.status).toBe("success");
    expect((store.read("repo")!.mrs[2]!.pr as any).pipeline.status).toBe("running"); // untouched
    expect((store.read("repo")!.mrs[3]!.pr as any).pipeline.status).toBe("success");
  });

  test("stuck pipelines drop out of top-up: in-flight but updatedAt older than 24h is skipped", async () => {
    const { TOPUP_MAX_AGE_MS } = await import("../project-sync.ts");
    const store = tmpStore();
    const stale = new Date(Date.now() - TOPUP_MAX_AGE_MS - 60_000).toISOString();
    const fresh = new Date(Date.now() - 60_000).toISOString();
    store.fullSync("repo", "g/p", [
      { ...prWithPipe(1, "created"), updatedAt: stale }, // stuck since forever -> skip
      { ...prWithPipe(2, "running"), updatedAt: fresh }, // genuinely live -> top-up
      prWithPipe(3, "running"),                          // no updatedAt -> treated fresh -> top-up
    ], Date.now() - 10_000);
    const singles: number[] = [];
    await syncProjectMRs(
      { repoIndex: () => ({ repo: "/tmp/repo" }), broadcast: () => {} },
      "repo",
      {
        store,
        fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
        fetchSingle: async (_r, _pp, iid) => { singles.push(iid); return prWithPipe(iid, "success"); },
      },
    );
    expect(singles.sort()).toEqual([2, 3]);
  });
});

describe("demand-scoped sync", () => {
  const deps = (repo: string) => ({ repoIndex: () => ({ [repo]: "/tmp/repo" }), broadcast: () => {} });
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  test("deep with demands uses the author fetch, filters to window, prunes the rest, records scope", async () => {
    const store = tmpStore();
    store.fullSync("s1", "g/p", [
      pr(1, { author: { username: "zombie" } as any, updatedAt: days(200) }),
    ], Date.now() - (DEEP_RECONCILE_MS + 60_000));
    store.registerDemand("s1", "board", ["alice"], Date.now());
    let authorsAsked: string[] | null = null;
    await syncProjectMRs(deps("s1"), "s1", {
      store, selfUsername: "me", windowDays: 30,
      fetchAuthors: async (_r, authors) => {
        authorsAsked = authors;
        return { projectPath: "g/p", prs: [
          pr(2, { author: { username: "alice" } as any, updatedAt: days(1) }),
          pr(3, { author: { username: "alice" } as any, updatedAt: days(45) }),  // outside window
        ] };
      },
      fetchDelta: async () => { throw new Error("must not delta"); },
    });
    expect(authorsAsked as string[] | null).toEqual(["alice", "me"]);
    const rec = store.read("s1")!;
    expect(rec.mrs[2]).toBeDefined();
    expect(rec.mrs[3]).toBeUndefined();       // window-filtered
    expect(rec.mrs[1]).toBeUndefined();       // pruned: out of scope
    expect(rec.scope).toEqual({ authors: ["alice", "me"], windowDays: 30 });
  });

  test("no demands and no self: deep stays the unscoped project sweep", async () => {
    const store = tmpStore();
    let projectFetch = false;
    await syncProjectMRs(deps("s2"), "s2", {
      store, selfUsername: null, windowDays: 30,
      fetchProject: async () => { projectFetch = true; return { projectPath: "g/p", prs: [pr(1)] }; },
      fetchAuthors: async () => { throw new Error("must not author-fetch"); },
    });
    expect(projectFetch).toBe(true);
  });

  test("delta drops MRs by out-of-scope authors when a scope exists", async () => {
    const store = tmpStore();
    store.fullSync("s3", "g/p", [], Date.now() - 1000);
    store.setScope("s3", { authors: ["alice"], windowDays: 30 });
    await syncProjectMRs(deps("s3"), "s3", {
      store,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [
        pr(4, { author: { username: "alice" } as any }),
        pr(5, { author: { username: "stranger" } as any }),
      ] }),
    });
    expect(store.read("s3")!.mrs[4]).toBeDefined();
    expect(store.read("s3")!.mrs[5]).toBeUndefined();
  });

  test("delta keeps an authorless MR when a scope exists -- never guess-drop (finding 3)", async () => {
    const store = tmpStore();
    store.fullSync("s3b", "g/p", [], Date.now() - 1000);
    store.setScope("s3b", { authors: ["alice"], windowDays: 30 });
    await syncProjectMRs(deps("s3b"), "s3b", {
      store,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [
        pr(6, { author: null as any }),
      ] }),
    });
    expect(store.read("s3b")!.mrs[6]).toBeDefined();
  });

  test("deep expires idle demands before computing scope", async () => {
    const store = tmpStore();
    store.fullSync("s4", "g/p", [], Date.now() - (DEEP_RECONCILE_MS + 60_000));
    store.registerDemand("s4", "dead", ["ghost"], 1);
    store.read("s4")!.demands!.dead!.lastSeenAt = 1;   // long idle
    let authorsAsked: string[] | null = null;
    await syncProjectMRs(deps("s4"), "s4", {
      store, selfUsername: "me", windowDays: 30,
      fetchAuthors: async (_r, a) => { authorsAsked = a; return { projectPath: "g/p", prs: [] }; },
    });
    expect(authorsAsked as string[] | null).toEqual(["me"]);
    expect(store.read("s4")!.demands!.dead).toBeUndefined();
  });

  test("backfillAuthors fetches just the named authors, upserts, extends scope, broadcasts", async () => {
    const store = tmpStore();
    store.fullSync("s5", "g/p", [], Date.now() - 1000);
    store.setScope("s5", { authors: ["alice"], windowDays: 30 });
    const events: any[] = [];
    await backfillAuthors(
      { repoIndex: () => ({ s5: "/tmp/repo" }), broadcast: (t, d) => events.push({ t, d }) },
      "s5", ["newbie"],
      { store, windowDays: 30, fetchAuthors: async (_r, a) => {
          expect(a).toEqual(["newbie"]);
          return { projectPath: "g/p", prs: [pr(9, { author: { username: "newbie" } as any, updatedAt: days(1) })] };
        } },
    );
    expect(store.read("s5")!.mrs[9]).toBeDefined();
    expect(store.read("s5")!.scope!.authors).toEqual(["alice", "newbie"]);
    expect(events.length).toBe(1);
  });

  test("backfillAuthors with a cached self includes self in the resulting scope (finding 1)", async () => {
    // A backfill against a previously unscoped store must not flip into
    // scoped mode without the daemon user's own username -- otherwise the
    // delta/events filters drop the user's own MRs until the next deep sync.
    const store = tmpStore();
    store.fullSync("s5b", "g/p", [], Date.now() - 1000);
    // No prior scope at all (the unscoped-store case the finding describes).
    await backfillAuthors(
      { repoIndex: () => ({ s5b: "/tmp/repo" }), broadcast: () => {} },
      "s5b", ["newbie"],
      { store, windowDays: 30, selfUsername: "me", fetchAuthors: async () => ({ projectPath: "g/p", prs: [] }) },
    );
    expect(store.read("s5b")!.scope!.authors).toEqual(["me", "newbie"]);
  });

  test("backfillAuthors with selfUsername explicitly null yields just the backfilled authors", async () => {
    const store = tmpStore();
    store.fullSync("s5c", "g/p", [], Date.now() - 1000);
    await backfillAuthors(
      { repoIndex: () => ({ s5c: "/tmp/repo" }), broadcast: () => {} },
      "s5c", ["newbie"],
      { store, windowDays: 30, selfUsername: null, fetchAuthors: async () => ({ projectPath: "g/p", prs: [] }) },
    );
    expect(store.read("s5c")!.scope!.authors).toEqual(["newbie"]);
  });

  test("backfillAuthors with an empty author list is a no-op: no fetch, no scope mutation, no broadcast", async () => {
    const store = tmpStore();
    store.fullSync("s6", "g/p", [], Date.now() - 1000);
    store.setScope("s6", { authors: ["alice"], windowDays: 30 });
    const events: any[] = [];
    await backfillAuthors(
      { repoIndex: () => ({ s6: "/tmp/repo" }), broadcast: (t, d) => events.push({ t, d }) },
      "s6", [],
      { store, fetchAuthors: async () => { throw new Error("must not fetch"); } },
    );
    expect(store.read("s6")!.scope!.authors).toEqual(["alice"]);
    expect(events.length).toBe(0);
  });

  test("unscoped deep clears a stale scope, so a subsequent delta stops misfiltering", async () => {
    const store = tmpStore();
    store.fullSync("s7", "g/p", [], Date.now() - (DEEP_RECONCILE_MS + 60_000));
    store.registerDemand("s7", "board", ["alice"], Date.now());
    await syncProjectMRs(deps("s7"), "s7", {
      store, selfUsername: "me", windowDays: 30,
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [] }),
      fetchDelta: async () => { throw new Error("must not delta"); },
    });
    expect(store.read("s7")!.scope).toEqual({ authors: ["alice", "me"], windowDays: 30 });

    // The demand goes idle past DEMAND_IDLE_EXPIRY_MS; a forced deep with no
    // demands left and no selfUsername override takes the unscoped sweep --
    // the exact production transition once a board tab closes.
    store.read("s7")!.demands!.board!.lastSeenAt = 1;
    await syncProjectMRs(deps("s7"), "s7", {
      store, mode: "deep",
      fetchProject: async () => ({ projectPath: "g/p", prs: [] }),
      fetchAuthors: async () => { throw new Error("must not author-fetch: no demands, no self"); },
    });
    expect(store.read("s7")!.scope).toBeUndefined();

    // A previously out-of-scope author's PR must land now that scope is gone.
    await syncProjectMRs(deps("s7"), "s7", {
      store,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [
        pr(8, { author: { username: "stranger" } as any }),
      ] }),
    });
    expect(store.read("s7")!.mrs[8]).toBeDefined();
  });
});

describe("codeowner section sweep (deep)", () => {
  const deps = (repo: string) => ({ repoIndex: () => ({ [repo]: "/tmp/repo" }), broadcast: () => {} });

  test("pure helpers: effectiveSections unions demands, sectionsMatching filters rules", () => {
    expect(effectiveSections({ demands: {
      a: { authors: ["x"], sections: ["Acme"], declaredAt: 1, lastSeenAt: 1 },
      b: { authors: ["y"], sections: ["Acme", "Beta"], declaredAt: 1, lastSeenAt: 1 },
    } } as any)).toEqual(["Acme", "Beta"]);
    expect(effectiveSections(undefined)).toEqual([]);
    expect(sectionsMatching(
      [{ type: "CODE_OWNER", approved: false, section: "Acme" },
       { type: "CODE_OWNER", approved: true, section: "Beta" },
       { type: "REGULAR", approved: false, section: null }],
      ["Acme", "Beta"],
    )).toEqual(["Acme"]);
  });

  test("deep with a sections demand sweeps rules, hydrates matches, keeps them past fullSync", async () => {
    const store = tmpStore();
    store.registerDemand("r1", "board:1", ["ada"], 1, ["Acme"]);
    const hydrated: number[] = [];
    await syncProjectMRs(deps("r1"), "r1", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [
        { iid: 1, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
        { iid: 9, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
        { iid: 5, rules: [{ type: "CODE_OWNER", approved: true, section: "Acme" }] },
      ] }),
      fetchSingle: async (_r, _p, iid) => { hydrated.push(iid); return pr(iid, { author: { username: "stranger" } as any }); },
    });
    const rec = store.read("r1")!;
    expect(hydrated).toEqual([9]);                       // 1 is author-covered, 5 unmatched
    expect(Object.keys(rec.mrs).sort()).toEqual(["1", "9"]);
    expect(rec.mrs[9]!.codeownerSections).toEqual(["Acme"]);
    expect(rec.mrs[1]!.codeownerSections).toEqual(["Acme"]); // tagged even when author-covered
    expect(rec.scope).toMatchObject({ sections: ["Acme"] });
  });

  test("deep sweep untags rows the sweep no longer matches (replaceAll)", async () => {
    const store = tmpStore();
    store.registerDemand("r2", "board:1", ["ada"], 1, ["Acme"]);
    // First deep: iid 1 is author-covered AND matches an unapproved CODE_OWNER rule.
    await syncProjectMRs(deps("r2"), "r2", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [
        { iid: 1, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
      ] }),
    });
    expect(store.read("r2")!.mrs[1]!.codeownerSections).toEqual(["Acme"]);

    // Second deep: iid 1 stays author-covered (fullSync retains the row --
    // the prune never fires), but the rule no longer matches. Only the
    // replaceAll write can clear this tag; the prune path is not exercised.
    await syncProjectMRs(deps("r2"), "r2", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [] }),
    });
    const rec = store.read("r2")!;
    expect(rec.mrs[1]).toBeDefined();                    // still in scope: not pruned
    expect(rec.mrs[1]!.codeownerSections).toBeUndefined();
  });

  test("hasStaleTags rollback: dropping a demand's sections clears a still-in-scope row's tag exactly once (finding 3)", async () => {
    const raw = tmpStore();
    let tagCalls = 0;
    const store = { ...raw, setSectionTags: (repoName: string, tags: Record<number, string[]>, opts?: { replaceAll?: boolean }) => {
      tagCalls++;
      raw.setSectionTags(repoName, tags, opts);
    } };
    store.registerDemand("r6", "board:1", ["ada"], 1, ["Acme"]);

    // 1st deep: iid 1 is author-covered and matches -> tagged.
    await syncProjectMRs(deps("r6"), "r6", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [
        { iid: 1, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
      ] }),
    });
    expect(raw.read("r6")!.mrs[1]!.codeownerSections).toEqual(["Acme"]);
    expect(tagCalls).toBe(1);

    // The demand drops its sections but keeps wanting the same author.
    store.registerDemand("r6", "board:1", ["ada"], 2);

    // 2nd deep: no sections demanded anymore, but iid 1 stays author-covered
    // -- the sweep is skipped (no fetchRules call), yet the stale tag from
    // before must still be cleared via the hasStaleTags rollback.
    await syncProjectMRs(deps("r6"), "r6", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => { throw new Error("must not fetch rules: no sections demanded"); },
    });
    expect(raw.read("r6")!.mrs[1]).toBeDefined();
    expect(raw.read("r6")!.mrs[1]!.codeownerSections).toBeUndefined();
    expect(tagCalls).toBe(2);

    // 3rd deep: nothing changed -- no stale tag left, no sections demanded
    // -> no further tag-clear write.
    await syncProjectMRs(deps("r6"), "r6", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => { throw new Error("must not fetch rules: no sections demanded"); },
    });
    expect(tagCalls).toBe(2);
  });

  test("containment: a demand without sections never calls fetchRules and never tags", async () => {
    const store = tmpStore();
    store.registerDemand("r3", "board:1", ["ada"], 1);
    let rulesCalled = 0;
    await syncProjectMRs(deps("r3"), "r3", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => { rulesCalled++; return { projectPath: "g/p", rules: [] }; },
    });
    expect(rulesCalled).toBe(0);
    expect(store.read("r3")!.mrs[1]!.codeownerSections).toBeUndefined();
    expect(store.read("r3")!.scope).toEqual({ authors: ["ada", "self"], windowDays: 30 });
  });

  test("backfillAuthors preserves an existing scope's sections (finding 1)", async () => {
    const store = tmpStore();
    store.fullSync("r5", "g/p", [], Date.now() - 1000);
    store.setScope("r5", { authors: ["alice"], sections: ["Acme"], windowDays: 30 });
    await backfillAuthors(
      deps("r5"), "r5", ["newbie"],
      { store, windowDays: 30, fetchAuthors: async () => ({ projectPath: "g/p", prs: [] }) },
    );
    expect(store.read("r5")!.scope).toEqual({ authors: ["alice", "newbie"], sections: ["Acme"], windowDays: 30 });
  });

  describe("backfillSections (finding 4)", () => {
    test("empty section list is a no-op: no fetch, no scope mutation, no broadcast", async () => {
      const store = tmpStore();
      store.fullSync("bs1", "g/p", [], Date.now() - 1000);
      store.setScope("bs1", { authors: ["alice"], sections: ["Acme"], windowDays: 30 });
      const events: any[] = [];
      await backfillSections(
        { repoIndex: () => ({ bs1: "/tmp/repo" }), broadcast: (t, d) => events.push({ t, d }) },
        "bs1", [],
        { store, fetchRules: async () => { throw new Error("must not fetch"); } },
      );
      expect(store.read("bs1")!.scope!.sections).toEqual(["Acme"]);
      expect(events.length).toBe(0);
    });

    test("hydrates only iids the store doesn't already have", async () => {
      const store = tmpStore();
      store.fullSync("bs2", "g/p", [pr(1, { author: { username: "alice" } as any })], Date.now() - 1000);
      store.setScope("bs2", { authors: ["alice"], windowDays: 30 });
      const hydrated: number[] = [];
      await backfillSections(
        { repoIndex: () => ({ bs2: "/tmp/repo" }), broadcast: () => {} },
        "bs2", ["Acme"],
        {
          store, windowDays: 30,
          fetchRules: async () => ({ projectPath: "g/p", rules: [
            { iid: 1, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] }, // already stored
            { iid: 2, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] }, // needs hydration
          ] }),
          fetchSingle: async (_r, _pp, iid) => { hydrated.push(iid); return pr(iid, { author: { username: "stranger" } as any }); },
        },
      );
      expect(hydrated).toEqual([2]);
      expect(store.read("bs2")!.mrs[2]).toBeDefined();
      expect(store.read("bs2")!.mrs[1]!.codeownerSections).toEqual(["Acme"]);
      expect(store.read("bs2")!.mrs[2]!.codeownerSections).toEqual(["Acme"]);
    });

    test("tags matches without replaceAll -- existing tags on other iids survive", async () => {
      const store = tmpStore();
      store.fullSync("bs3", "g/p", [
        pr(1, { author: { username: "alice" } as any }),
        pr(2, { author: { username: "alice" } as any }),
      ], Date.now() - 1000);
      store.setSectionTags("bs3", { 1: ["Beta"] });
      store.setScope("bs3", { authors: ["alice"], sections: ["Beta"], windowDays: 30 });
      await backfillSections(
        { repoIndex: () => ({ bs3: "/tmp/repo" }), broadcast: () => {} },
        "bs3", ["Acme"],
        {
          store, windowDays: 30,
          fetchRules: async () => ({ projectPath: "g/p", rules: [
            { iid: 2, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
          ] }),
        },
      );
      expect(store.read("bs3")!.mrs[1]!.codeownerSections).toEqual(["Beta"]);      // untouched: not replaceAll
      expect(store.read("bs3")!.mrs[2]!.codeownerSections).toEqual(["Acme"]);
    });

    test("unions sections into an existing scope, sorted", async () => {
      const store = tmpStore();
      store.fullSync("bs4", "g/p", [], Date.now() - 1000);
      store.setScope("bs4", { authors: ["alice"], sections: ["Beta"], windowDays: 30 });
      await backfillSections(
        { repoIndex: () => ({ bs4: "/tmp/repo" }), broadcast: () => {} },
        "bs4", ["Acme"],
        { store, windowDays: 30, fetchRules: async () => ({ projectPath: "g/p", rules: [] }) },
      );
      expect(store.read("bs4")!.scope!.sections).toEqual(["Acme", "Beta"]);
    });

    test("with no existing scope leaves scope unset (the `if (scope)` guard)", async () => {
      const store = tmpStore();
      store.fullSync("bs5", "g/p", [], Date.now() - 1000);
      await backfillSections(
        { repoIndex: () => ({ bs5: "/tmp/repo" }), broadcast: () => {} },
        "bs5", ["Acme"],
        { store, windowDays: 30, fetchRules: async () => ({ projectPath: "g/p", rules: [] }) },
      );
      expect(store.read("bs5")!.scope).toBeUndefined();
    });
  });
});

describe("delta retag and keep-tagged-strangers", () => {
  /** Seeds a real scope {authors:["ada","self"], sections:["Acme"]} via one deep sync; iid 9 is not author-covered so it's hydrated and tagged. */
  async function seededSectionStore() {
    const store = tmpStore();
    const deps = { repoIndex: () => ({ r: "/tmp/repo" }), broadcast: () => {} };
    store.registerDemand("r", "board:1", ["ada"], 1, ["Acme"]);
    await syncProjectMRs(deps, "r", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [
        { iid: 9, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
      ] }),
      fetchSingle: async (_r, _p, iid) => pr(iid, { author: { username: "stranger" } as any }),
    });
    return { store, deps };
  }

  /** Seeds a real scope {authors:["ada","self"]} only -- no demand ever declared a section. */
  async function seededAuthorOnlyStore() {
    const store = tmpStore();
    const deps = { repoIndex: () => ({ r: "/tmp/repo" }), broadcast: () => {} };
    store.registerDemand("r", "board:1", ["ada"], 1);
    await syncProjectMRs(deps, "r", {
      store, selfUsername: "self", windowDays: 30, mode: "deep",
      fetchAuthors: async () => ({ projectPath: "g/p", prs: [] }),
    });
    return { store, deps };
  }

  test("delta keeps a tagged stranger's update and retags from the cycle's rules", async () => {
    const { store, deps } = await seededSectionStore(); // deep already ran: iid 9 tagged, stored
    await syncProjectMRs(deps, "r", {
      store, selfUsername: "self", windowDays: 30,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [
        pr(9, { author: { username: "stranger" } as any, title: "v2" }),
        pr(3, { author: { username: "stranger" } as any }),
      ] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [
        { iid: 9, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
      ] }),
      fetchSingle: async () => { throw new Error("nothing to hydrate"); },
    });
    const rec = store.read("r")!;
    expect(rec.mrs[9]!.pr.title).toBe("v2");                       // tagged stranger's update kept
    expect(rec.mrs[9]!.codeownerSections).toEqual(["Acme"]);
    expect(rec.mrs[3]).toBeUndefined();                             // untagged stranger filtered
  });

  test("delta untags an MR whose rule got approved in-window", async () => {
    const { store, deps } = await seededSectionStore();
    // iid 9 also carries a pr update this cycle, so applyDelta's own
    // preserve-copy runs on the same entry the fresh sweep is about to
    // clear -- proving the sweep's clear wins over the preserve, not just
    // that setSectionTags can clear a row applyDelta never touched.
    await syncProjectMRs(deps, "r", {
      store, selfUsername: "self", windowDays: 30,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [
        pr(9, { author: { username: "self" } as any, title: "v2" }),
      ] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [
        { iid: 9, rules: [{ type: "CODE_OWNER", approved: true, section: "Acme" }] },
      ] }),
    });
    const rec = store.read("r")!;
    expect(rec.mrs[9]!.pr.title).toBe("v2");         // the delta update itself still landed
    // Tag cleared; the row itself waits for the deep prune.
    expect(rec.mrs[9]!.codeownerSections).toBeUndefined();
  });

  test("delta hydrates AND tags a brand-new match in the same cycle", async () => {
    const { store, deps } = await seededSectionStore(); // iid 4 unknown to the store
    await syncProjectMRs(deps, "r", {
      store, selfUsername: "self", windowDays: 30,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
      fetchRules: async () => ({ projectPath: "g/p", rules: [
        { iid: 4, rules: [{ type: "CODE_OWNER", approved: false, section: "Acme" }] },
      ] }),
      fetchSingle: async (_r, _p, iid) => pr(iid, { author: { username: "stranger" } as any }),
    });
    const rec = store.read("r")!;
    expect(rec.mrs[4]).toBeDefined();
    expect(rec.mrs[4]!.codeownerSections).toEqual(["Acme"]); // tag applied after hydration
  });

  test("delta with no section scope never calls fetchRules (containment)", async () => {
    const { store, deps } = await seededAuthorOnlyStore(); // scope {authors} only
    let rulesCalled = 0;
    await syncProjectMRs(deps, "r", {
      store, selfUsername: "self", windowDays: 30,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [pr(1, { author: { username: "ada" } as any })] }),
      fetchRules: async () => { rulesCalled++; return { projectPath: "g/p", rules: [] }; },
    });
    expect(rulesCalled).toBe(0);
  });

  test("a failing retag this cycle still keeps the tag: applyDelta preserves it in memory", async () => {
    const { store, deps } = await seededSectionStore(); // iid 9 tagged, stored
    await syncProjectMRs(deps, "r", {
      store, selfUsername: "self", windowDays: 30,
      fetchDelta: async () => ({ projectPath: "g/p", prs: [
        pr(9, { author: { username: "stranger" } as any, title: "v2" }),
      ] }),
      fetchRules: async () => { throw new Error("rules endpoint down"); },
    });
    const rec = store.read("r")!;
    expect(rec.mrs[9]!.pr.title).toBe("v2");                        // delta update still applied
    expect(rec.mrs[9]!.codeownerSections).toEqual(["Acme"]);   // tag survives despite the failed retag
  });

  test("a tag-only change (untagged this cycle, no pr change) still broadcasts", async () => {
    const { store, deps } = await seededSectionStore(); // iid 9 tagged, stored
    const events: Array<{ type: string; data: any }> = [];
    await syncProjectMRs(
      { ...deps, broadcast: (type, data) => events.push({ type, data }) },
      "r",
      {
        store, selfUsername: "self", windowDays: 30,
        fetchDelta: async () => ({ projectPath: "g/p", prs: [] }),
        fetchRules: async () => ({ projectPath: "g/p", rules: [{ iid: 9, rules: [] }] }),
      },
    );
    expect(store.read("r")!.mrs[9]!.codeownerSections).toBeUndefined();
    expect(events).toEqual([{ type: "project-mrs", data: { repoName: "r", iids: [9] } }]);
  });
});
