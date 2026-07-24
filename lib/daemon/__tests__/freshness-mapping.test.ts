import { describe, test, expect } from "bun:test";
import {
  applyInvalidationBatch,
  type FreshnessEnv,
  type RepoTarget,
  type BatchRunner,
} from "../freshness.ts";
import type { InvalidationKey } from "@workforge/glance-sdk";

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

function makeEnv(entries: Record<string, any>): { env: FreshnessEnv; broadcasts: Array<{ type: string; data: any }>; flushes: { count: number } } {
  const broadcasts: Array<{ type: string; data: any }> = [];
  const flushes = { count: 0 };
  const env: FreshnessEnv = {
    ctx: {
      cache: { entries },
      flushCache: () => { flushes.count++; },
    } as any,
    broadcast: (type, data) => broadcasts.push({ type, data }),
  };
  return { env, broadcasts, flushes };
}

function makeRunner(): BatchRunner {
  return { processing: false, pending: [], gapFillTimer: null };
}

const noNotify = { notify: () => {}, gapFillDebounceMs: 10 };

function key(kind: InvalidationKey["kind"], ref: string): InvalidationKey {
  return { kind, ref, cause: "test" };
}

describe("applyInvalidationBatch", () => {
  test("mr key with cached iid refetches that MR and updates the entry", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, ticket: { id: "T-1" }, linearId: "T-1", fetchedAt: 1, repoName: "repo-x" },
    };
    const { env, broadcasts, flushes } = makeEnv(entries);
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
    expect(flushes.count).toBe(1);
    expect(broadcasts.filter((b) => b.type === "mr:update").length).toBe(1);
    expect(broadcasts[0]!.data).toEqual({ repoName: "repo-x", mrs: { 42: entries["feat-a"].mr } });
  });

  test("mr key for another repo's iid is ignored", async () => {
    const entries: Record<string, any> = {
      "feat-a": { mr: { iid: 42 }, fetchedAt: 1, repoName: "other-repo" },
    };
    const { env, flushes } = makeEnv(entries);
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
    expect(flushes.count).toBe(0);
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
      { ...noNotify, refreshDiscussions: async (_e, repo, iid) => { refreshed.push([repo, iid]); } },
    );
    expect(refreshed).toEqual([["repo-x", 42]]);   // 777 is not ours → ignored
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
    const { env, flushes } = makeEnv(entries);
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
    expect(flushes.count).toBe(1);
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
      { notify: () => { notifyCount++; }, gapFillDebounceMs: 10 },
    );
    expect(notifyCount).toBe(1);
  });
});
