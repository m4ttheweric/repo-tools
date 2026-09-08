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
});
