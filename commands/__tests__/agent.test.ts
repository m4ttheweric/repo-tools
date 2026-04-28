import { describe, expect, test } from "bun:test";
import {
  resolveAgentTargetPath,
  type AgentTargetDeps,
} from "../agent.ts";
import type { KnownRepo, RepoIdentity } from "../../lib/repo.ts";

function identity(repoRoot: string): RepoIdentity {
  return {
    repoName: "repo",
    repoRoot,
    dataDir: "/tmp/.rt/repo",
    remoteUrl: "git@example.com:org/repo.git",
    baseUrl: "https://example.com/org/repo",
  };
}

function repo(worktrees: string[]): KnownRepo {
  return {
    repoName: "repo",
    dataDir: "/tmp/.rt/repo",
    worktrees: worktrees.map((path, index) => ({
      path,
      branch: index === 0 ? "main" : `feature-${index}`,
      isBare: false,
    })),
  };
}

function deps(overrides: Partial<AgentTargetDeps>): AgentTargetDeps {
  return {
    cwd: "/cwd",
    repos: [],
    identity: null,
    repoRoot: null,
    pickWorktreeWithSwitch: async () => {
      throw new Error("pickWorktreeWithSwitch should not be called");
    },
    pickFromAllRepos: async () => {
      throw new Error("pickFromAllRepos should not be called");
    },
    ...overrides,
  };
}

describe("resolveAgentTargetPath", () => {
  test("uses the current repo root without a picker when there are no linked worktrees", async () => {
    const target = await resolveAgentTargetPath([], deps({
      identity: identity("/repo"),
      repos: [repo(["/repo"])],
    }));

    expect(target).toBe("/repo");
  });

  test("uses the current git root without a picker when the repo has no rt identity", async () => {
    const target = await resolveAgentTargetPath([], deps({
      identity: null,
      repoRoot: "/local-repo",
      repos: [],
    }));

    expect(target).toBe("/local-repo");
  });

  test("uses the current worktree without a picker when the repo has linked worktrees", async () => {
    const target = await resolveAgentTargetPath([], deps({
      identity: identity("/repo-feature"),
      repos: [repo(["/repo", "/repo-feature"])],
    }));

    expect(target).toBe("/repo-feature");
  });

  test("shows the all-repos picker when outside a repo", async () => {
    let called = false;
    const target = await resolveAgentTargetPath([], deps({
      repos: [repo(["/repo"])],
      pickFromAllRepos: async () => {
        called = true;
        return "/repo";
      },
    }));

    expect(called).toBe(true);
    expect(target).toBe("/repo");
  });

  test("-p forces a picker inside a repo with one known worktree", async () => {
    let called = false;
    const target = await resolveAgentTargetPath(["-p"], deps({
      identity: identity("/repo"),
      repos: [repo(["/repo"])],
      pickFromAllRepos: async () => {
        called = true;
        return "/other";
      },
    }));

    expect(called).toBe(true);
    expect(target).toBe("/other");
  });

  test("--pick uses the current repo worktree picker when multiple worktrees exist", async () => {
    let called = false;
    const target = await resolveAgentTargetPath(["--pick"], deps({
      identity: identity("/repo-feature"),
      repos: [repo(["/repo", "/repo-feature"])],
      pickWorktreeWithSwitch: async () => {
        called = true;
        return "/repo";
      },
    }));

    expect(called).toBe(true);
    expect(target).toBe("/repo");
  });

  test("--here keeps the exact current directory", async () => {
    const target = await resolveAgentTargetPath(["--here"], deps({
      cwd: "/repo-feature/packages/app",
      identity: identity("/repo-feature"),
      repos: [repo(["/repo", "/repo-feature"])],
    }));

    expect(target).toBe("/repo-feature/packages/app");
  });
});
