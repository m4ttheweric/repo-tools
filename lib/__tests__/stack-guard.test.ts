import { describe, expect, test } from "bun:test";

import {
  STACK_REFUSAL_EXIT,
  checkStackMembership,
  createStackGuardRunners,
  renderStackRefusal,
  type StackGuardRunners,
  type StackRefusal,
} from "../stack-guard.ts";
import { fakeProbes, missing, ok, type ExecScript } from "../setup/__tests__/fakes.ts";

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
        stackName: "acme-1599",
        root: "master",
        nodes: [
          { branch: "acme-2626-log-call", parent: "master" },
          { branch: "acme-2627-assign", parent: "acme-2626-log-call" },
          { branch: "acme-1599-contacts", parent: "acme-2626-log-call" },
        ],
      },
    ]);
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "acme-2626-log-call",
      defaultBranch: "master",
      runners: runners({ gitqStacks: async () => store }),
    });

    expect(verdict.verdict).toBe("refuse");
    if (verdict.verdict !== "refuse") return;
    expect(verdict.refusal.kind).toBe("stack-refusal");
    expect(verdict.refusal.source).toBe("gitq");
    expect(verdict.refusal.branch).toBe("acme-2626-log-call");
    expect(verdict.refusal.stack).toEqual({
      name: "acme-1599",
      root: "master",
      parent: "master",
      children: ["acme-2627-assign", "acme-1599-contacts"],
    });
    expect(verdict.refusal.tool).toBe("gitq sync --stack acme-1599");
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

describe("createStackGuardRunners", () => {
  const GITHUB = "git@github.com:acme/widgets.git";
  const GITLAB = "https://gitlab.acme.internal/acme/widgets.git";

  function scripted(remote: string, forge: ExecScript): ExecScript {
    return (argv, opts) => {
      if (argv[0] === "git" && argv[1] === "remote") return ok(remote + "\n");
      return forge(argv, opts);
    };
  }

  test("gitqStacks runs gitq stacks --json in cwd and hands back stdout", async () => {
    const p = fakeProbes({ exec: () => ok('{"stacks":[]}') });
    const out = await createStackGuardRunners(p).gitqStacks("/wt");
    expect(out).toBe('{"stacks":[]}');
    expect(p.calls.exec).toEqual([["gitq", "stacks", "--json", "-C", "/wt"]]);
  });

  test("gitqStacks is null when gitq is missing", async () => {
    const p = fakeProbes({ exec: () => missing("gitq") });
    expect(await createStackGuardRunners(p).gitqStacks("/wt")).toBeNull();
  });

  test("forgeOpenMrs on GitHub lists open PRs via gh and maps head/base", async () => {
    const p = fakeProbes({
      exec: scripted(GITHUB, () => ok(JSON.stringify([
        { number: 5, headRefName: "child", baseRefName: "parent", url: "https://github.com/acme/widgets/pull/5" },
      ]))),
    });
    const res = await createStackGuardRunners(p).forgeOpenMrs("/wt");
    expect(res).toEqual({ ok: true, mrs: [{ iid: 5, source: "child", target: "parent", url: "https://github.com/acme/widgets/pull/5" }] });
    expect(p.calls.exec[1]).toEqual(["gh", "pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,baseRefName,url"]);
  });

  test("forgeOpenMrs on self-hosted GitLab lists via glab with GITLAB_HOST and maps source/target", async () => {
    let seenEnv: Record<string, string> | undefined;
    const p = fakeProbes({
      exec: scripted(GITLAB, (argv, opts) => {
        seenEnv = opts?.env;
        return ok(JSON.stringify([
          { iid: 9, source_branch: "child", target_branch: "parent", web_url: "https://gitlab.acme.internal/acme/widgets/-/merge_requests/9" },
        ]));
      }),
    });
    const res = await createStackGuardRunners(p).forgeOpenMrs("/wt");
    expect(res).toEqual({ ok: true, mrs: [{ iid: 9, source: "child", target: "parent", url: "https://gitlab.acme.internal/acme/widgets/-/merge_requests/9" }] });
    expect(p.calls.exec[1]).toEqual(["glab", "mr", "list", "--output", "json", "--per-page", "100"]);
    expect(seenEnv).toEqual({ GITLAB_HOST: "gitlab.acme.internal" });
  });

  test("forgeOpenMrs reports the CLI failure instead of guessing", async () => {
    const p = fakeProbes({ exec: scripted(GITHUB, () => ({ code: 4, stdout: "", stderr: "gh: not logged in" })) });
    const res = await createStackGuardRunners(p).forgeOpenMrs("/wt");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not logged in");
  });

  test("forgeOpenMrs fails when origin is not a recognised forge", async () => {
    const p = fakeProbes({ exec: scripted("ssh://git.example.org/x/y.git", () => ok("[]")) });
    const res = await createStackGuardRunners(p).forgeOpenMrs("/wt");
    expect(res.ok).toBe(false);
    expect(p.calls.exec).toHaveLength(1);
  });

  test("forgeOpenMrs lists once per remote across worktrees", async () => {
    const p = fakeProbes({ exec: scripted(GITHUB, () => ok("[]")) });
    const r = createStackGuardRunners(p);
    await r.forgeOpenMrs("/wt-a");
    await r.forgeOpenMrs("/wt-b");
    expect(p.calls.exec.filter((a) => a[0] === "gh")).toHaveLength(1);
  });
});

describe("renderStackRefusal", () => {
  const refusal: StackRefusal = {
    kind: "stack-refusal",
    branch: "feat",
    source: "gitq",
    stack: { name: "s1", root: "master", parent: "master", children: [] },
    mrs: null,
    tool: "gitq sync --stack s1",
    hint: "feat is a member of stack s1",
  };

  test("json mode is the refusal object, parseable as-is", () => {
    const out = renderStackRefusal(refusal, "json");
    expect(JSON.parse(out)).toEqual(refusal);
  });

  test("human mode is one line naming the reason and the tool", () => {
    const out = renderStackRefusal(refusal, "human");
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("feat is a member of stack s1");
    expect(out).toContain("gitq sync --stack s1");
  });

  test("human mode names the tool exactly once for a real gitq refusal", async () => {
    const store = gitqStore([{ stackName: "s1", root: "master", nodes: [{ branch: "feat", parent: "master" }] }]);
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat",
      defaultBranch: "master",
      runners: runners({ gitqStacks: async () => store }),
    });
    if (verdict.verdict !== "refuse") throw new Error("expected refusal");
    const out = renderStackRefusal(verdict.refusal, "human");
    expect(out.split("gitq sync --stack s1")).toHaveLength(2);
    expect(out).toContain("Run: gitq sync --stack s1");
  });

  test("human mode names the tool exactly once for a forge refusal", async () => {
    const verdict = await checkStackMembership({
      cwd: "/repo",
      branch: "feat-child",
      defaultBranch: "master",
      runners: runners({
        forgeOpenMrs: async () => ({ ok: true, mrs: [{ iid: 1, source: "feat-child", target: "feat-parent", url: "u" }] }),
      }),
    });
    if (verdict.verdict !== "refuse") throw new Error("expected refusal");
    const out = renderStackRefusal(verdict.refusal, "human");
    expect(out.split("gitq track")).toHaveLength(2);
    expect(out).toContain("Run: gitq track");
  });

  test("the refusal exit code is distinct from the paused-conflict bundle's 3", () => {
    expect(STACK_REFUSAL_EXIT).toBe(4);
  });
});
