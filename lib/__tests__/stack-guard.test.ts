import { describe, expect, test } from "bun:test";

import { checkStackMembership, type StackGuardRunners } from "../stack-guard.ts";

function gitqStore(stacks: { stackName: string; root: string; nodes: { branch: string; parent: string }[] }[]): string {
  return JSON.stringify({ stacks, worktrees: [] });
}

function runners(over: Partial<StackGuardRunners>): StackGuardRunners {
  return {
    gitqStacks: async () => null,
    forgeOpenMrs: async () => ({ ok: true, mrs: [] }),
    ...over,
  };
}

describe("checkStackMembership", () => {
  test("refuses a gitq stack member, naming its stack, parent, and children", async () => {
    const store = gitqStore([
      {
        stackName: "cv-1599",
        root: "master",
        nodes: [
          { branch: "cv-2626-log-call", parent: "master" },
          { branch: "cv-2627-assign", parent: "cv-2626-log-call" },
          { branch: "cv-1599-contacts", parent: "cv-2626-log-call" },
        ],
      },
    ]);
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "cv-2626-log-call",
      defaultBranch: "master",
      runners: runners({ gitqStacks: async () => store }),
    });

    expect(verdict.verdict).toBe("refuse");
    if (verdict.verdict !== "refuse") return;
    expect(verdict.refusal.kind).toBe("stack-refusal");
    expect(verdict.refusal.source).toBe("gitq");
    expect(verdict.refusal.branch).toBe("cv-2626-log-call");
    expect(verdict.refusal.stack).toEqual({
      name: "cv-1599",
      root: "master",
      parent: "master",
      children: ["cv-2627-assign", "cv-1599-contacts"],
    });
    expect(verdict.refusal.tool).toBe("gitq sync --stack cv-1599");
  });

  test("refuses via the forge when the branch's open MR targets a non-default branch", async () => {
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat-child",
      defaultBranch: "master",
      runners: runners({
        forgeOpenMrs: async () => ({
          ok: true,
          mrs: [{ iid: 42, source: "feat-child", target: "feat-parent", url: "https://forge/mr/42" }],
        }),
      }),
    });

    expect(verdict.verdict).toBe("refuse");
    if (verdict.verdict !== "refuse") return;
    expect(verdict.refusal.source).toBe("forge");
    expect(verdict.refusal.stack).toBeNull();
    expect(verdict.refusal.mrs).toEqual([{ iid: 42, source: "feat-child", target: "feat-parent", url: "https://forge/mr/42" }]);
    expect(verdict.refusal.hint).toContain("targets feat-parent");
    expect(verdict.refusal.tool).toBe("gitq track");
  });

  test("refuses via the forge when an open MR targets the branch (it has dependents)", async () => {
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat-parent",
      defaultBranch: "master",
      runners: runners({
        forgeOpenMrs: async () => ({
          ok: true,
          mrs: [
            { iid: 7, source: "feat-parent", target: "master", url: "https://forge/mr/7" },
            { iid: 8, source: "feat-child", target: "feat-parent", url: "https://forge/mr/8" },
          ],
        }),
      }),
    });

    expect(verdict.verdict).toBe("refuse");
    if (verdict.verdict !== "refuse") return;
    expect(verdict.refusal.source).toBe("forge");
    expect(verdict.refusal.mrs).toEqual([{ iid: 8, source: "feat-child", target: "feat-parent", url: "https://forge/mr/8" }]);
    expect(verdict.refusal.hint).toContain("feat-child");
  });

  test("a branch whose only open MR targets the default branch is clear", async () => {
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat-solo",
      defaultBranch: "master",
      runners: runners({
        forgeOpenMrs: async () => ({
          ok: true,
          mrs: [{ iid: 9, source: "feat-solo", target: "master", url: "https://forge/mr/9" }],
        }),
      }),
    });

    expect(verdict).toEqual({ verdict: "clear" });
  });

  test("gitq knows the repo but not this branch: falls through to the forge", async () => {
    const store = gitqStore([{ stackName: "other", root: "master", nodes: [{ branch: "x", parent: "master" }] }]);
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat-child",
      defaultBranch: "master",
      runners: runners({
        gitqStacks: async () => store,
        forgeOpenMrs: async () => ({
          ok: true,
          mrs: [{ iid: 1, source: "feat-child", target: "feat-parent", url: "https://forge/mr/1" }],
        }),
      }),
    });

    expect(verdict.verdict).toBe("refuse");
    if (verdict.verdict !== "refuse") return;
    expect(verdict.refusal.source).toBe("forge");
  });

  test("forge listing fails: unverified, carrying the error", async () => {
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat",
      defaultBranch: "master",
      runners: runners({ forgeOpenMrs: async () => ({ ok: false, error: "gh: not logged in" }) }),
    });

    expect(verdict.verdict).toBe("unverified");
    if (verdict.verdict !== "unverified") return;
    expect(verdict.refusal.kind).toBe("stack-check-unavailable");
    expect(verdict.refusal.source).toBe("forge");
    expect(verdict.refusal.stack).toBeNull();
    expect(verdict.refusal.mrs).toBeNull();
    expect(verdict.refusal.hint).toContain("gh: not logged in");
  });

  test("gitq unavailable and no open MRs involve the branch: clear", async () => {
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat",
      defaultBranch: "master",
      runners: runners({}),
    });

    expect(verdict).toEqual({ verdict: "clear" });
  });
});
