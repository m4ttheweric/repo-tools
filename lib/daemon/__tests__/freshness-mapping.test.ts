import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyInvalidationBatch,
  type FreshnessEnv,
  type RepoTarget,
  type BatchRunner,
} from "../freshness.ts";
import { createProjectMRs } from "../project-mrs-store.ts";
import type { InvalidationKey } from "@mattstack/glance";
import { fakeStore } from "./fake-cache-store.ts";
import { getBranchCacheStore, openStateDb } from "../../state/index.ts";

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "rt-freshness-mapping-")), "state.db");
}

// RT-48: project-mrs persistence moved off project-mrs.json to state.db —
// fresh temp db per call, same isolation createProjectMRs(tmpStorePath(), 0) had.
function pmrsStore() {
  return createProjectMRs(openStateDb(tmpStorePath(), "cli"));
}

// Minimal PullRequest stand-in: toMRInfo (glance-sdk toMRDashboardProps) reads
// many optional fields; provide the required scalars and leave the rest
// undefined. If toMRInfo throws on this shape, extend the factory with the
// missing fields rather than mocking toMRInfo.
function fakePR(iid: number, overrides: Record<string, any> = {}): any {
  return {
    id: `gid://gitlab/MergeRequest/${iid}`,
    iid,
    repositoryId: "gid://gitlab/Repository/1",
    title: `MR ${iid}`,
    description: "",
    state: "opened",
    draft: false,
    conflicts: false,
    webUrl: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
    sourceBranch: `branch-${iid}`,
    targetBranch: "main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sha: "abc123def456",
    author: { id: "gid://gitlab/User/1", username: "someone", name: "Someone", avatarUrl: null },
    assignees: [],
    reviewers: [],
    roles: [],
    pipeline: null,
    unresolvedThreadCount: 0,
    approvalsLeft: 0,
    approved: false,
    approvedBy: [],
    diffStats: null,
    detailedMergeStatus: "mergeable",
    autoMergeEnabled: false,
    autoMergeStrategy: null,
    mergeUser: null,
    mergeAfter: null,
    divergedCommitsCount: 0,
    rebaseInProgress: false,
    mergeOngoing: false,
    inProgressMergeCommitSha: null,
    mergeError: null,
    shouldBeRebased: false,
    mergeabilityChecks: [],
    blockingMergeRequestsCount: 0,
    approvalsRequired: 0,
    squash: false,
    squashOnMerge: false,
    mergeTrainIndex: null,
    ...overrides,
  };
}

function makeEnv(entries: Record<string, any>): { env: FreshnessEnv; broadcasts: Array<{ type: string; data: any }>; puts: string[] } {
  const broadcasts: Array<{ type: string; data: any }> = [];
  // RT-48: the old fake counted flushCache() calls. There is no flush any
  // more — write-through happens at updateEntry via store.put — so the
  // equivalent observation is which branches got put.
  const puts: string[] = [];
  const store = fakeStore(entries);
  const env: FreshnessEnv = {
    ctx: {
      cache: {
        ...store,
        put: (branch: string, entry: any) => { puts.push(branch); store.put(branch, entry); },
      },
    } as any,
    broadcast: (type, data) => broadcasts.push({ type, data }),
  };
  return { env, broadcasts, puts };
}

function makeRunner(): BatchRunner {
  return { processing: false, pending: [], gapFillTimer: null };
}

// Branches-only grant: describes every legacy test below (gap-fill scheduling,
// branch-entry-only refresh) — none of them intend to exercise the
// project-mrs/discussions fan-out, so pin the grant explicitly rather than
// rely on the real (filesystem-backed) default resolving to "off" the same way.
const branchesOnlyGrants = () => ({ mode: "live" as const, caches: new Set(["branches"] as const), projectMrsWindowDays: 30 });
const noNotify = { notify: () => {}, gapFillDebounceMs: 10, grantsFor: branchesOnlyGrants };

// Full grant: branches + project-mrs + discussions. Used by the new
// project-store-fan-out tests below.
const projectGrants = () => ({ mode: "live" as const, caches: new Set(["branches", "project-mrs", "discussions"] as const), projectMrsWindowDays: 30 });

function key(kind: InvalidationKey["kind"], ref: string): InvalidationKey {
  return { kind, ref, cause: "test" };
}

describe("applyInvalidationBatch", () => {
  test("mr key with cached iid refetches that MR and updates the entry", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, ticket: { id: "T-1" }, linearId: "T-1", fetchedAt: 1, repoName: "repo-x" },
    };
    const { env, broadcasts, puts } = makeEnv(entries);
    const calls: any[] = [];
    const target: RepoTarget = {
      repoName: "repo-x",
      projectPath: "g/p",
      provider: {
        fetchSingleMR: async (pp: string, iid: number) => { calls.push(["single", pp, iid]); return fakePR(42); },
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };

    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "42")], noNotify);

    expect(calls).toEqual([["single", "g/p", 42]]);
    expect(entries["feat-a"].mr.iid).toBe(42);
    expect(entries["feat-a"].fetchedAt).toBeGreaterThan(1);
    expect(entries["feat-a"].ticket).toEqual({ id: "T-1" });   // enrichment preserved
    expect(entries["feat-a"].linearId).toBe("T-1");
    expect(puts).toEqual(["feat-a"]);
    expect(broadcasts.filter((b) => b.type === "mr:update").length).toBe(1);
    expect(broadcasts[0]!.data).toEqual({ repoName: "repo-x", mrs: { 42: entries["feat-a"].mr } });
  });

  test("mr key for another repo's iid is ignored", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, fetchedAt: 1, repoName: "other-repo" },
    };
    const { env, puts } = makeEnv(entries);
    let called = false;
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => { called = true; return null; },
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    const runner = makeRunner();
    await applyInvalidationBatch(env, target, runner, [key("mr", "42")], noNotify);
    expect(called).toBe(false);
    expect(puts).toEqual([]);
    // unknown iid schedules a gap-fill instead
    expect(runner.gapFillTimer).not.toBeNull();
    clearTimeout(runner.gapFillTimer!);
  });

  test("unknown mr key gap-fills null-mr branches after debounce", async () => {
    const entries: Record<string, any> = {
      "no-mr-branch": { mr: null, fetchedAt: 1, repoName: "repo-x" },
      "has-mr":       { mr: { iid: 7 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    const batchCalls: string[][] = [];
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => null,
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async (_pp: string, branches: string[]) => {
          batchCalls.push(branches);
          return new Map([["no-mr-branch", fakePR(99, { sourceBranch: "no-mr-branch" })]]);
        },
      } as any,
    };
    const runner = makeRunner();
    await applyInvalidationBatch(env, target, runner, [key("mr", "999")], noNotify);
    expect(batchCalls.length).toBe(0);                       // debounced, not immediate
    await new Promise((r) => setTimeout(r, 40));             // > gapFillDebounceMs (10)
    expect(batchCalls).toEqual([["no-mr-branch"]]);          // only null-mr branches
    expect(entries["no-mr-branch"].mr.iid).toBe(99);
  });

  test("disposed runner never arms gapFillTimer for an unknown mr key", async () => {
    const entries: Record<string, any> = {
      "no-mr-branch": { mr: null, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    let batchCalled = false;
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => null,
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => { batchCalled = true; return new Map(); },
      } as any,
    };
    const runner: BatchRunner = { ...makeRunner(), disposed: true };
    await applyInvalidationBatch(env, target, runner, [key("mr", "999")], noNotify);
    expect(runner.gapFillTimer).toBeNull();                  // scheduleGapFill bailed immediately
    await new Promise((r) => setTimeout(r, 40));              // > gapFillDebounceMs (10)
    expect(batchCalled).toBe(false);                          // no fetch ever ran
  });

  test("unknown mr key with no null-mr branches skips the batch fetch entirely", async () => {
    const entries: Record<string, any> = {
      "has-mr": { mr: { iid: 7 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    let batchCalled = false;
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => null,
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => { batchCalled = true; return new Map(); },
      } as any,
    };
    const runner = makeRunner();
    await applyInvalidationBatch(env, target, runner, [key("mr", "999")], noNotify);
    await new Promise((r) => setTimeout(r, 40));
    expect(batchCalled).toBe(false);
  });

  test("notes key routes through refreshDiscussions override for cached iids only", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    const refreshed: Array<[string, number]> = [];
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => fakePR(42),
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(
      env, target, makeRunner(),
      [key("notes", "42"), key("notes", "777")],
      {
        ...noNotify,
        grantsFor: () => ({ mode: "live" as const, caches: new Set(["branches", "discussions"] as const), projectMrsWindowDays: 30 }),
        // Only 42's discussions are "cached" here — hasCachedDiscussions (not
        // branch membership) is the gate now that the old branchByIid.has(iid)
        // check is gone, so 777 must be excluded via this stub instead.
        hasCachedDiscussions: (_repo, iid) => iid === 42,
        refreshDiscussions: async (_e, repo, iid) => { refreshed.push([repo, iid]); },
      },
    );
    expect(refreshed).toEqual([["repo-x", 42]]);   // 777's discussions aren't cached → ignored
  });

  test("branch key refetches by branch; unknown branch and pipelines are ignored", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    const calls: any[] = [];
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => null,
        fetchPullRequestByBranch: async (_pp: string, branch: string, state: string) => {
          calls.push([branch, state]);
          return fakePR(42, { sourceBranch: branch });
        },
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    const runner = makeRunner();
    await applyInvalidationBatch(env, target, runner, [
      key("branch", "feat-a"),
      key("branch", "someone-elses-branch"),
      key("pipelines", "*"),
    ], noNotify);
    expect(calls).toEqual([["feat-a", "all"]]);
    expect(runner.gapFillTimer).toBeNull();   // unknown branch does NOT gap-fill
  });

  test("branch refetch returning null writes mr: null (MR deleted/never existed)", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, ticket: null, linearId: "", fetchedAt: 1, repoName: "repo-x" },
    };
    const { env, puts } = makeEnv(entries);
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => null,
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("branch", "feat-a")], noNotify);
    expect(entries["feat-a"].mr).toBeNull();
    expect(puts).toEqual(["feat-a"]);
  });

  test("concurrent batch merges into pending and processes after current run", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 1 }, fetchedAt: 1, repoName: "repo-x" },
      "feat-b": { mr: { iid: 2 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    const fetched: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => {
          fetched.push(iid);
          if (iid === 1) await firstGate;
          return fakePR(iid);
        },
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    const runner = makeRunner();
    const p1 = applyInvalidationBatch(env, target, runner, [key("mr", "1")], noNotify);
    const p2 = applyInvalidationBatch(env, target, runner, [key("mr", "2")], noNotify);
    await p2;                          // second call returns immediately (queued)
    expect(fetched).toEqual([1]);      // 2 not fetched yet — still pending
    releaseFirst();
    await p1;                          // first call drains pending
    expect(fetched).toEqual([1, 2]);
  });

  test("duplicate keys within a batch are processed once", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    let count = 0;
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => { count++; return fakePR(42); },
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "42"), key("mr", "42")], noNotify);
    expect(count).toBe(1);
  });

  test("a throwing fetch drops that key and continues with the rest", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 1 }, fetchedAt: 1, repoName: "repo-x" },
      "feat-b": { mr: { iid: 2 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => {
          if (iid === 1) throw new Error("boom");
          return fakePR(2);
        },
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "1"), key("mr", "2")], noNotify);
    expect(entries["feat-a"].mr.iid).toBe(1);         // untouched
    expect(entries["feat-b"].mr.iid).toBe(2);         // still updated
  });

  test("notify fires once per mutating batch with current userId", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 1 }, fetchedAt: 1, repoName: "repo-x" },
      "feat-b": { mr: { iid: 2 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    let notifyCount = 0;
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => fakePR(iid),
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(
      env, target, makeRunner(),
      [key("mr", "1"), key("mr", "2")],
      { notify: () => { notifyCount++; }, gapFillDebounceMs: 10, grantsFor: branchesOnlyGrants },
    );
    expect(notifyCount).toBe(1);
  });

  // ─── project-mrs fan-out (grant-scoped) ───────────────────────────────────

  test("mr event with project grant: unknown iid fetches once, upserts store, no gap-fill", async () => {
    const store = pmrsStore();
    store.fullSync("repo-x", "g/p", [], Date.now() - 1000);
    const { env, broadcasts } = makeEnv({});
    const fetched: number[] = [];
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => { fetched.push(iid); return fakePR(42); },
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };
    const runner = makeRunner();
    await applyInvalidationBatch(env, target, runner, [key("mr", "42")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(fetched).toEqual([42]);                            // fetched once, no gap-fill fallback
    expect(runner.gapFillTimer).toBeNull();
    expect(store.read("repo-x")!.mrs[42]).toBeDefined();
    expect(broadcasts.some((b) => b.type === "project-mrs")).toBe(true);
  });

  test("mr event, iid on a local branch: ONE fetch feeds branch entry AND project store", async () => {
    const store = pmrsStore();
    const entries: Record<string, any> = {
      feat: { mr: { iid: 7 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    const calls: number[] = [];
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => { calls.push(iid); return fakePR(7); },
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "7")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(calls).toEqual([7]);                               // exactly one fetch, not two
    expect(entries.feat.fetchedAt).toBeGreaterThan(1);        // branch entry refreshed
    expect(store.read("repo-x")!.mrs[7]).toBeDefined();       // project store also fed
  });

  test("mr event, iid NOT in branchByIid but entry keyed by PR's sourceBranch has mr: null: ONE fetch feeds branch entry AND project store", async () => {
    const store = pmrsStore();
    const entries: Record<string, any> = {
      "branch-42": { mr: null, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    const calls: number[] = [];
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        // fakePR(42) has sourceBranch "branch-42" (see fakePR factory above).
        fetchSingleMR: async (_pp: string, iid: number) => { calls.push(iid); return fakePR(42); },
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "42")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(calls).toEqual([42]);                                // exactly one fetch
    expect(entries["branch-42"].mr).not.toBeNull();              // branch entry filled via sourceBranch feed
    expect(entries["branch-42"].mr.iid).toBe(42);
    expect(entries["branch-42"].fetchedAt).toBeGreaterThan(1);
    expect(store.read("repo-x")!.mrs[42]).toBeDefined();         // project store also fed
  });

  test("branch push with local entry + project grant: fetchPullRequestByBranch result reused, NO fetchSingleMR", async () => {
    const store = pmrsStore();
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const { env } = makeEnv(entries);
    let singleCalled = false;
    const byBranchCalls: string[] = [];
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => { singleCalled = true; return null; },
        fetchPullRequestByBranch: async (_pp: string, branch: string) => {
          byBranchCalls.push(branch);
          return fakePR(42, { sourceBranch: branch });
        },
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("branch", "feat-a")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(byBranchCalls).toEqual(["feat-a"]);                // exactly one branch fetch
    expect(singleCalled).toBe(false);                         // never a second (by-iid) fetch
    expect(store.read("repo-x")!.mrs[42]!.pr.sourceBranch).toBe("feat-a");
  });

  test("teammate branch push (no local entry): store sourceBranch hit → fetchSingleMR by iid → upsert", async () => {
    const store = pmrsStore();
    store.fullSync("repo-x", "g/p", [fakePR(9, { sourceBranch: "feat-9", state: "opened" })], Date.now() - 1000);
    const { env } = makeEnv({});
    const singleCalls: number[] = [];
    let byBranchCalled = false;
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => { singleCalls.push(iid); return fakePR(9, { sourceBranch: "feat-9" }); },
        fetchPullRequestByBranch: async () => { byBranchCalled = true; return null; },
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("branch", "feat-9")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(byBranchCalled).toBe(false);                       // no local entry → local handling never runs
    expect(singleCalls).toEqual([9]);                         // resolved via store, fetched by iid
    expect(store.read("repo-x")!.mrs[9]).toBeDefined();
  });

  test("teammate branch push with no store match: no fetch at all", async () => {
    const store = pmrsStore();
    const { env } = makeEnv({});
    let anyCalled = false;
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => { anyCalled = true; return null; },
        fetchPullRequestByBranch: async () => { anyCalled = true; return null; },
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("branch", "feat-unknown")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(anyCalled).toBe(false);
  });

  // ─── events fan-out scope filter (Task 6) ─────────────────────────────────

  test("mr event, scope present + out-of-scope author: no upsert, no broadcast", async () => {
    const store = pmrsStore();
    store.fullSync("repo-x", "g/p", [], Date.now() - 1000);
    store.setScope("repo-x", { authors: ["alice"], windowDays: 30 });
    const { env, broadcasts } = makeEnv({});
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        // fakePR's default author username is "someone", not in scope.
        fetchSingleMR: async (_pp: string, iid: number) => fakePR(iid),
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "42")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(store.read("repo-x")!.mrs[42]).toBeUndefined();
    expect(broadcasts.some((b) => b.type === "project-mrs")).toBe(false);
  });

  test("mr event, scope present + in-scope author: upsert proceeds", async () => {
    const store = pmrsStore();
    store.fullSync("repo-x", "g/p", [], Date.now() - 1000);
    store.setScope("repo-x", { authors: ["someone"], windowDays: 30 });
    const { env, broadcasts } = makeEnv({});
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => fakePR(iid),
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "42")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(store.read("repo-x")!.mrs[42]).toBeDefined();
    expect(broadcasts.some((b) => b.type === "project-mrs")).toBe(true);
  });

  test("mr event, no scope set: upsert proceeds regardless of author (legacy)", async () => {
    const store = pmrsStore();
    store.fullSync("repo-x", "g/p", [], Date.now() - 1000); // no setScope call
    const { env } = makeEnv({});
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => fakePR(iid),
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "42")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(store.read("repo-x")!.mrs[42]).toBeDefined();
  });

  test("mr event, scope present + PR has no author: never guess-drop, upsert proceeds", async () => {
    const store = pmrsStore();
    store.fullSync("repo-x", "g/p", [], Date.now() - 1000);
    store.setScope("repo-x", { authors: ["alice"], windowDays: 30 });
    const { env } = makeEnv({});
    const target: RepoTarget = {
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async (_pp: string, iid: number) => fakePR(iid, { author: null }),
        fetchPullRequestByBranch: async () => { throw new Error("unexpected"); },
        fetchPullRequestsByBranches: async () => { throw new Error("unexpected"); },
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("mr", "42")], {
      ...noNotify, grantsFor: projectGrants, projectStore: store,
    });
    expect(store.read("repo-x")!.mrs[42]).toBeDefined();
  });

  test("notes: no discussions grant → no refresh; grant without cached discussions → no refresh; both → refresh", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, fetchedAt: 1, repoName: "repo-x" },
    };
    const refreshed: number[] = [];
    const makeTarget = (): RepoTarget => ({
      repoName: "repo-x", projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => fakePR(42),
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    });
    const refreshDiscussions = async (_e: FreshnessEnv, _repo: string, iid: number) => { refreshed.push(iid); };

    // Sub-case 1: project-mrs granted but no discussions grant → no refresh.
    {
      const { env } = makeEnv(entries);
      await applyInvalidationBatch(env, makeTarget(), makeRunner(), [key("notes", "42")], {
        ...noNotify,
        grantsFor: () => ({ mode: "live" as const, caches: new Set(["branches", "project-mrs"] as const), projectMrsWindowDays: 30 }),
        hasCachedDiscussions: () => true,
        refreshDiscussions,
      });
    }
    expect(refreshed).toEqual([]);

    // Sub-case 2: discussions granted but this MR's discussions aren't cached → no refresh.
    {
      const { env } = makeEnv(entries);
      await applyInvalidationBatch(env, makeTarget(), makeRunner(), [key("notes", "42")], {
        ...noNotify,
        grantsFor: () => ({ mode: "live" as const, caches: new Set(["branches", "discussions"] as const), projectMrsWindowDays: 30 }),
        hasCachedDiscussions: () => false,
        refreshDiscussions,
      });
    }
    expect(refreshed).toEqual([]);

    // Sub-case 3: both discussions grant AND cached discussions → refresh fires.
    {
      const { env } = makeEnv(entries);
      await applyInvalidationBatch(env, makeTarget(), makeRunner(), [key("notes", "42")], {
        ...noNotify,
        grantsFor: () => ({ mode: "live" as const, caches: new Set(["branches", "discussions"] as const), projectMrsWindowDays: 30 }),
        hasCachedDiscussions: () => true,
        refreshDiscussions,
      });
    }
    expect(refreshed).toEqual([42]);

    // Sub-case 4: an iid with NO local branch entry still refreshes — the old
    // branchByIid.has(iid) gate is gone; hasCachedDiscussions is now the only gate.
    {
      const { env } = makeEnv({}); // no branch entries at all
      await applyInvalidationBatch(env, makeTarget(), makeRunner(), [key("notes", "999")], {
        ...noNotify,
        grantsFor: () => ({ mode: "live" as const, caches: new Set(["branches", "discussions"] as const), projectMrsWindowDays: 30 }),
        hasCachedDiscussions: () => true,
        refreshDiscussions,
      });
    }
    expect(refreshed).toEqual([42, 999]);
  });
});

// ─── RT-48 write-through (spec test 4) ───────────────────────────────────────

/**
 * `updateEntry` (the true mutation site behind every targeted refresh) writes
 * the row, not just the map. The old design mutated `ctx.cache.entries` and
 * relied on a batch-tail `ctx.flushCache()` to persist it; anything that
 * ended the process in between lost the update. There is no flush to call any
 * more — these tests prove persistence by throwing the in-memory map away and
 * rebuilding it from the database on a second connection.
 */
describe("write-through at updateEntry (RT-48)", () => {
  function realStoreEnv(dir: string, seed: Record<string, any>) {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath);
    const store = getBranchCacheStore(db);
    for (const [branch, entry] of Object.entries(seed)) store.put(branch, entry);

    const broadcasts: Array<{ type: string; data: any }> = [];
    const env: FreshnessEnv = {
      ctx: { cache: store } as any,
      broadcast: (type, data) => broadcasts.push({ type, data }),
    };
    return { env, store, db, dbPath, broadcasts };
  }

  /** The "kill the in-memory map" half: a fresh connection, a fresh map. */
  function rebuildFromDb(dbPath: string): Record<string, any> {
    const db = openStateDb(dbPath);
    const entries = { ...getBranchCacheStore(db).entries };
    db.close();
    return entries;
  }

  test("a targeted MR refresh survives a map rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-writethrough-"));
    const { env, db, dbPath } = realStoreEnv(dir, {
      "feat-a": { ticket: { id: "T-1" }, linearId: "T-1", mr: null, fetchedAt: 1, repoName: "repo-x" },
    });

    const target: RepoTarget = {
      repoName: "repo-x",
      projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => fakePR(42),
        fetchPullRequestByBranch: async () => fakePR(42),
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("branch", "feat-a")], noNotify);
    db.close(); // the daemon dies here — no flush, no shutdown hook, nothing

    const rebuilt = rebuildFromDb(dbPath);
    expect(rebuilt["feat-a"]).toBeDefined();
    expect(rebuilt["feat-a"].mr.iid).toBe(42);
    expect(rebuilt["feat-a"].fetchedAt).toBeGreaterThan(1);
    // Enrichment the events path never touches is preserved through the row.
    expect(rebuilt["feat-a"].ticket).toEqual({ id: "T-1" });
    expect(rebuilt["feat-a"].linearId).toBe("T-1");
    expect(rebuilt["feat-a"].repoName).toBe("repo-x");
  });

  test("a refresh that clears an MR persists the null, not the stale MR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-writethrough-null-"));
    const { env, db, dbPath } = realStoreEnv(dir, {
      "feat-b": { ticket: null, linearId: "", mr: { iid: 7 }, fetchedAt: 1, repoName: "repo-x" },
    });

    const target: RepoTarget = {
      repoName: "repo-x",
      projectPath: "g/p",
      provider: {
        fetchSingleMR: async () => null,
        fetchPullRequestByBranch: async () => null,
        fetchPullRequestsByBranches: async () => new Map(),
      } as any,
    };
    await applyInvalidationBatch(env, target, makeRunner(), [key("branch", "feat-b")], noNotify);
    db.close();

    expect(rebuildFromDb(dbPath)["feat-b"].mr).toBeNull();
  });

  test("the store exposes no flush of any kind — persistence is not optional", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-writethrough-api-"));
    const db = openStateDb(join(dir, "state.db"));
    const store = getBranchCacheStore(db);
    expect(Object.keys(store).sort()).toEqual(["delete", "entries", "gc", "put", "reload"]);
    db.close();
  });
});
