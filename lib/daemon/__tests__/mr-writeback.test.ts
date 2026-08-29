import { describe, expect, test } from "bun:test";
import { createMRHandlers, RETRY_WRITEBACK_DELAY_MS } from "../handlers/mr.ts";
import { ReadBackFailedError } from "@mattstack/glance";
import type { HandlerContext } from "../handlers/types.ts";
import { fakeStore } from "./fake-cache-store.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeCtx = () => ({ cache: fakeStore({}), repoIndex: () => ({ repo: "/tmp/repo" }) }) as unknown as HandlerContext;
const prOf = (iid: number, state = "opened") => ({ iid, state, sourceBranch: `b${iid}` }) as any;

function harness(provider: Record<string, unknown>) {
  const writebacks: any[] = [];
  const singles: number[] = [];
  const handlers = createMRHandlers(fakeCtx(), () => {}, {
    getContext: async () => ({ provider, projectPath: "g/p" }),
    writeback: (repo, pp, pr) => writebacks.push({ repo, pp, iid: pr.iid, state: pr.state }),
    fetchSingle: async (_p, _pp, iid) => { singles.push(iid); return prOf(iid, "refetched"); },
    retryDelayMs: 10,
  });
  return { handlers, writebacks, singles };
}

describe("mr:action write-back", () => {
  test("merge uses the returned PR: writeback once, zero fetchSingle", async () => {
    const { handlers, writebacks, singles } = harness({ mergePullRequest: async () => prOf(7, "merged") });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 7, action: "merge", args: [] }) as any;
    expect(res.ok).toBe(true);
    expect(writebacks).toEqual([{ repo: "repo", pp: "g/p", iid: 7, state: "merged" }]);
    expect(singles).toEqual([]);
  });

  test("toggleDraft uses updatePullRequest's returned PR", async () => {
    const { handlers, writebacks, singles } = harness({ updatePullRequest: async () => prOf(8) });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 8, action: "toggleDraft", args: [true] }) as any;
    expect(res.ok).toBe(true);
    expect(writebacks.length).toBe(1);
    expect(singles).toEqual([]);
  });

  test("void action (approve): exactly one immediate follow-up fetch then writeback", async () => {
    const { handlers, writebacks, singles } = harness({ approvePullRequest: async () => {} });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 9, action: "approve", args: [] }) as any;
    expect(res.ok).toBe(true);
    expect(singles).toEqual([9]);
    expect(writebacks.length).toBe(1);
  });

  test("retry action: delayed single follow-up", async () => {
    const { handlers, writebacks, singles } = harness({ retryPipeline: async () => {} });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 3, action: "retryPipeline", args: [555] }) as any;
    expect(res.ok).toBe(true);
    expect(singles).toEqual([]);          // not yet
    const start = Date.now();
    while (singles.length === 0 && Date.now() - start < 500) await sleep(10);
    expect(singles).toEqual([3]);
    expect(writebacks.length).toBe(1);
  });

  test("follow-up failure never fails the action", async () => {
    const writebacks: any[] = [];
    const handlers = createMRHandlers(fakeCtx(), () => {}, {
      getContext: async () => ({ provider: { approvePullRequest: async () => {} }, projectPath: "g/p" }),
      writeback: (r, p, pr) => writebacks.push(pr),
      fetchSingle: async () => { throw new Error("fetch broke"); },
    });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 1, action: "approve", args: [] }) as any;
    expect(res.ok).toBe(true);
    expect(writebacks).toEqual([]);
  });

  test("RETRY_WRITEBACK_DELAY_MS is 5s in production", () => {
    expect(RETRY_WRITEBACK_DELAY_MS).toBe(5000);
  });
});

describe("mr:action read-back failures", () => {
  const readBackFailed = (operation: string, iid: number) =>
    new ReadBackFailedError("failed to fetch it back: GraphQL errors: Timeout", {
      operation, projectPath: "g/p", iid, writeApplied: true,
    });

  test("a draft flip whose read-back failed still reports success and refreshes", async () => {
    // The MAT-169 case: GitLab applied the flip, the read-back timed out, and
    // the board toasted an error over a write that had worked.
    const { handlers, writebacks, singles } = harness({
      updatePullRequest: async () => { throw readBackFailed("updatePullRequest", 8); },
    });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 8, action: "toggleDraft", args: [true] }) as any;
    expect(res.ok).toBe(true);
    // No returned PR to write back, so it falls through to the follow-up fetch
    // the void actions use -- the stores still end up with a fresh shape.
    expect(singles).toEqual([8]);
    expect(writebacks.length).toBe(1);
  });

  test("a merge whose read-back failed is not reported as a failed merge", async () => {
    const { handlers, singles } = harness({
      mergePullRequest: async () => { throw readBackFailed("mergePullRequest", 7); },
    });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 7, action: "merge", args: [] }) as any;
    expect(res.ok).toBe(true);
    expect(singles).toEqual([7]);
  });

  test("a genuinely rejected write still fails the action", async () => {
    // Nothing landed on the forge, so reporting success would tell the client
    // a merge happened that did not.
    const { handlers, singles } = harness({
      mergePullRequest: async () => { throw new Error("405 method not allowed"); },
    });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 7, action: "merge", args: [] }) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("405");
    expect(singles).toEqual([]);
  });

  test("a read-back failure with no write behind it still fails the action", async () => {
    const { handlers } = harness({
      mergePullRequest: async () => {
        throw new ReadBackFailedError("watchMR", {
          operation: "watchMR", projectPath: "g/p", iid: 7, writeApplied: false,
        });
      },
    });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 7, action: "merge", args: [] }) as any;
    expect(res.ok).toBe(false);
  });
});
