import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { syncProjectMRs, backfillAuthors, DEEP_RECONCILE_MS, DEEP_RETRY_BACKOFF_MS, DELTA_OVERLAP_MS } from "../project-sync.ts";
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

  test("demand registers before the freshness gate and is monotonic", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [], Date.now());
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store, sync: async () => {}, tracking: grantedTracking });
    await h["project-mrs:read"]!({ repoName: "repo", demand: { client: "b:1", authors: ["x"], declaredAt: 5 } });
    await h["project-mrs:read"]!({ repoName: "repo", demand: { client: "b:1", authors: ["stale"], declaredAt: 4 } });
    expect(store.read("repo")!.demands!["b:1"]!.authors).toEqual(["x"]);
  });

  test("malformed demand is rejected without registering", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [], Date.now());
    const h = createProjectMRsHandlers(fakeCtx, () => {}, { store, sync: async () => {}, tracking: grantedTracking });
    const res = await h["project-mrs:read"]!({ repoName: "repo", demand: { client: "", authors: ["x"], declaredAt: 1 } });
    expect(res.ok).toBe(false);
    expect(store.read("repo")!.demands).toBeUndefined();
  });

  test("uncovered demanded authors are reported and kick a backfill on unforced reads", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [], Date.now());
    store.setScope("repo", { authors: ["alice"], windowDays: 30 });
    const backfilled: string[][] = [];
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => {}, tracking: grantedTracking,
      backfill: async (_r, authors) => { backfilled.push(authors); },
    });
    const res = await h["project-mrs:read"]!({ repoName: "repo",
      demand: { client: "b:1", authors: ["alice", "newbie"], declaredAt: 1 } });
    expect(res.ok).toBe(true);
    expect((res.data as any).scope).toEqual({ authors: ["alice"], windowDays: 30, uncovered: ["newbie"] });
    await new Promise((r) => setTimeout(r, 0));   // fire-and-forget settles
    expect(backfilled).toEqual([["newbie"]]);
  });

  test("forced read with uncovered authors awaits the backfill", async () => {
    const store = tmpStore();
    store.fullSync("repo", "g/p", [], Date.now() - 60_000);
    store.setScope("repo", { authors: [], windowDays: 30 });
    const order: string[] = [];
    const h = createProjectMRsHandlers(fakeCtx, () => {}, {
      store, sync: async () => { order.push("sync"); }, tracking: grantedTracking,
      backfill: async () => { order.push("backfill"); },
    });
    await h["project-mrs:read"]!({ repoName: "repo", maxAgeMs: 0,
      demand: { client: "b:1", authors: ["newbie"], declaredAt: 1 } });
    expect(order).toEqual(["sync", "backfill"]);
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
