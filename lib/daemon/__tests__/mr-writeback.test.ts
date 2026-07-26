import { describe, expect, test } from "bun:test";
import { createMRHandlers, RETRY_WRITEBACK_DELAY_MS } from "../handlers/mr.ts";
import type { HandlerContext } from "../handlers/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeCtx = () => ({ cache: { entries: {} }, flushCache: () => {}, loadCache: () => {}, repoIndex: () => ({ repo: "/tmp/repo" }) }) as unknown as HandlerContext;
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
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 7, action: "merge", args: [] });
    expect(res.ok).toBe(true);
    expect(writebacks).toEqual([{ repo: "repo", pp: "g/p", iid: 7, state: "merged" }]);
    expect(singles).toEqual([]);
  });

  test("toggleDraft uses updatePullRequest's returned PR", async () => {
    const { handlers, writebacks, singles } = harness({ updatePullRequest: async () => prOf(8) });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 8, action: "toggleDraft", args: [true] });
    expect(res.ok).toBe(true);
    expect(writebacks.length).toBe(1);
    expect(singles).toEqual([]);
  });

  test("void action (approve): exactly one immediate follow-up fetch then writeback", async () => {
    const { handlers, writebacks, singles } = harness({ approvePullRequest: async () => {} });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 9, action: "approve", args: [] });
    expect(res.ok).toBe(true);
    expect(singles).toEqual([9]);
    expect(writebacks.length).toBe(1);
  });

  test("retry action: delayed single follow-up", async () => {
    const { handlers, writebacks, singles } = harness({ retryPipeline: async () => {} });
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 3, action: "retryPipeline", args: [555] });
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
    const res = await handlers["mr:action"]!({ repoName: "repo", iid: 1, action: "approve", args: [] });
    expect(res.ok).toBe(true);
    expect(writebacks).toEqual([]);
  });

  test("RETRY_WRITEBACK_DELAY_MS is 5s in production", () => {
    expect(RETRY_WRITEBACK_DELAY_MS).toBe(5000);
  });
});
