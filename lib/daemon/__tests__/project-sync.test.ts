import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { syncProjectMRs, DEEP_RECONCILE_MS, DELTA_OVERLAP_MS } from "../project-sync.ts";
import { createProjectMRs } from "../project-mrs-store.ts";
import type { PullRequest } from "@workforge/glance-sdk";

function pr(iid: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `gitlab:mr:${iid}`, iid, title: `MR ${iid}`, state: "opened",
    sourceBranch: `b${iid}`, targetBranch: "main", webUrl: "", divergedCommitsCount: null,
    ...over,
  } as unknown as PullRequest;
}
function tmpStore() {
  return createProjectMRs(join(mkdtempSync(join(tmpdir(), "rt-psync-")), "s.json"), 0);
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

describe("project-mrs:read handler", async () => {
  const { createProjectMRsHandlers } = await import("../handlers/project-mrs.ts");
  const fakeCtx = { repoIndex: () => ({ repo: "/tmp/repo" }) } as any;
  const grantedTracking = () => ({ repo: { mode: "live" as const, caches: ["branches", "project-mrs"] as any } });

  test("grant denied → instructive error, sync never runs", async () => {
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store: tmpStore(), sync: async () => { synced++; }, tracking: () => ({}),
    });
    const res = await h["project-mrs:read"]!({ repoName: "repo" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("project-mrs cache not granted for repo");
    expect(res.error).toContain("rt daemon track repo live branches,project-mrs");
    expect(synced).toBe(0);
  });

  test("maxAgeMs 0 always forces the per-repo sync; fresh store skips it", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [pr(1)], Date.now());     // listSyncedAt ≈ now
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => { synced++; }, tracking: grantedTracking,
    });
    await h["project-mrs:read"]!({ repoName: "repo", maxAgeMs: 60_000 });  // fresh → no sync
    expect(synced).toBe(0);
    await h["project-mrs:read"]!({ repoName: "repo", maxAgeMs: 0 });       // 0 → forces
    expect(synced).toBe(1);
  });

  test("no maxAgeMs → serve whatever the store has; empty store → empty shape", async () => {
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store: tmpStore(), sync: async () => { synced++; }, tracking: grantedTracking,
    });
    const res = await h["project-mrs:read"]!({ repoName: "repo" });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ mrs: {}, listSyncedAt: 0, source: "poll", syncedAt: 0 });
    expect(synced).toBe(0);
  });

  test("sync failure surfaces as an error, not a crash", async () => {
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store: tmpStore(), sync: async () => { throw new Error("boom"); }, tracking: grantedTracking,
    });
    const res = await h["project-mrs:read"]!({ repoName: "repo", maxAgeMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("project sync failed");
  });

  test("freshness gate honors deltaSyncedAt: old listSyncedAt but fresh deltaSyncedAt → no sync", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [pr(1)], Date.now() - 10 * 60_000); // stale as a deep sync
    store.applyDelta("repo", "g/p", [pr(1)], Date.now());             // but delta-fresh
    let synced = 0;
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => { synced++; }, tracking: grantedTracking,
    });
    const res = await h["project-mrs:read"]!({ repoName: "repo", maxAgeMs: 60_000 });
    expect(synced).toBe(0);
    expect(res.ok).toBe(true);
    expect(res.data.syncedAt).toBe(store.read("repo")!.deltaSyncedAt);
  });
});
