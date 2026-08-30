/**
 * The worktree CLI is the SENDER side of the identity re-key — it must
 * serialize identities into daemon payloads and reverse-resolve `--repo`
 * (name/path/identity) the same way, or the daemon's now identity-only
 * handlers silently stop matching anything this CLI sends.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { repoLabel, worktreeList, worktreeProvision } from "../worktree.ts";
import { getRepoIdentity } from "../../lib/repo.ts";
import { closeStateDb } from "../../lib/state/index.ts";
import { deriveRepoIdentity, serializeIdentity } from "../../lib/settings/identity.ts";
import type { DaemonResponse } from "../../lib/daemon-client.ts";

// mock.module mutates the live "../../lib/daemon-client.ts" namespace object
// IN PLACE, so `realDaemonClient.daemonQuery` itself becomes the mock the
// moment one is installed — restoring with `() => realDaemonClient` would
// restore the mock to itself. Capture the individual real bindings BEFORE
// any mock.module call in this file, and restore with THOSE.
const realDaemonClient = await import("../../lib/daemon-client.ts");
const realDaemonQuery = realDaemonClient.daemonQuery;
const realLastQueryTimedOut = realDaemonClient.lastQueryTimedOut;

interface Captured {
  cmd: string;
  payload?: Record<string, unknown>;
}

function installFakeDaemon(response: DaemonResponse): Captured[] {
  const calls: Captured[] = [];
  mock.module("../../lib/daemon-client.ts", () => ({
    ...realDaemonClient,
    daemonQuery: async (cmd: string, payload?: Record<string, unknown>) => {
      calls.push({ cmd, payload });
      return response;
    },
    lastQueryTimedOut: () => false,
  }));
  return calls;
}

describe("worktree CLI identity plumbing", () => {
  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  let home: string;
  let reposRoot: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-worktree-cli-home-")));
    reposRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-worktree-cli-repos-")));
    process.env.HOME = home;
    closeStateDb();
    process.chdir(home); // neutral cwd: no repo directory lives under here
  });

  afterEach(() => {
    mock.module("../../lib/daemon-client.ts", () => ({
      ...realDaemonClient,
      daemonQuery: realDaemonQuery,
      lastQueryTimedOut: realLastQueryTimedOut,
    }));
    process.chdir(origCwd);
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(reposRoot, { recursive: true, force: true });
  });

  function makeGitRepo(name: string): string {
    const dir = realpathSync(mkdtempSync(join(reposRoot, `${name}-`)));
    execSync("git init -q -b main", { cwd: dir });
    return dir;
  }

  test("in-repo default sends the SERIALIZED IDENTITY to the daemon, not a bare basename", async () => {
    const repoPath = makeGitRepo("provision-repo");
    process.chdir(repoPath);
    const identity = serializeIdentity(await deriveRepoIdentity(repoPath));

    const calls = installFakeDaemon({
      ok: true,
      data: { tree: "t", path: "p", branch: "b", branchState: "new" },
    });

    await worktreeProvision(["--ticket", "RT-1", "--json"], {});

    const call = calls.find((c) => c.cmd === "worktree:provision");
    expect(call).toBeDefined();
    expect(call!.payload!.repoName).toMatch(/^(remote|path):/);
    expect(call!.payload!.repoName).toBe(identity);
    // Never the plain directory basename — that's the display name, not the key.
    expect(call!.payload!.repoName).not.toBe(basename(repoPath));
  });

  test("--repo <name> reverse-resolves to the identity for a repo registered under an identity key", async () => {
    const repoPath = makeGitRepo("named-repo");
    // Visiting the repo once (as any rt command would) is what populates the
    // identity-keyed index resolveRepoArg's name-lookup branch reads.
    process.chdir(repoPath);
    const identity = getRepoIdentity()!.identity;
    process.chdir(home); // leave the repo — --repo must do the resolving, not cwd

    const calls = installFakeDaemon({ ok: true, data: { trees: [] } });

    await worktreeList(["--repo", basename(repoPath), "--json"], {});

    const call = calls.find((c) => c.cmd === "worktree:list");
    expect(call?.payload?.repoName).toBe(identity);
  });

  test("--repo <path> derives the identity from the directory", async () => {
    const repoPath = makeGitRepo("path-repo");
    const identity = serializeIdentity(await deriveRepoIdentity(repoPath));

    const calls = installFakeDaemon({ ok: true, data: { trees: [] } });

    await worktreeList(["--repo", repoPath, "--json"], {});

    const call = calls.find((c) => c.cmd === "worktree:list");
    expect(call?.payload?.repoName).toBe(identity);
  });

  test("--repo <already-serialized-identity> passes through unchanged", async () => {
    const repoPath = makeGitRepo("identity-arg-repo");
    const identity = serializeIdentity(await deriveRepoIdentity(repoPath));

    const calls = installFakeDaemon({ ok: true, data: { trees: [] } });

    await worktreeList(["--repo", identity, "--json"], {});

    const call = calls.find((c) => c.cmd === "worktree:list");
    expect(call?.payload?.repoName).toBe(identity);
  });

  test("an unresolvable --repo exits with a clear message instead of sending a bogus key to the daemon", async () => {
    const calls = installFakeDaemon({ ok: true, data: { trees: [] } });
    const exitSpy = mock(() => {
      throw new Error("process.exit sentinel");
    });
    const originalExit = process.exit;
    process.exit = exitSpy as unknown as typeof process.exit;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };

    try {
      await expect(worktreeList(["--repo", "no-such-repo-anywhere", "--json"], {})).rejects.toThrow();
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }

    expect(calls.find((c) => c.cmd === "worktree:list")).toBeUndefined();
    expect(logs.some((l) => l.includes("no-such-repo-anywhere"))).toBe(true);
  });

  test("JSON output includes readyHeldRepos alongside trees", async () => {
    installFakeDaemon({ ok: true, data: { trees: [], readyHeldRepos: ["path:/foo"] } });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };

    try {
      await worktreeList(["--json"], {});
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.readyHeldRepos).toEqual(["path:/foo"]);
  });

  test("held-repo notice prints even when there are no worktrees", async () => {
    installFakeDaemon({ ok: true, data: { trees: [], readyHeldRepos: ["path:/foo"] } });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };

    try {
      await worktreeList([], {});
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l.includes("held pending approval"))).toBe(true);
  });
});

describe("repoLabel", () => {
  test("decodes a remote identity to its trailing path segment", () => {
    expect(repoLabel("remote:gitlab.com%2Fg%2Frepo")).toBe("repo");
  });

  test("decodes a path identity to its basename", () => {
    expect(repoLabel(`path:${encodeURIComponent("/Users/matt/repo-tools")}`)).toBe("repo-tools");
  });

  test("a value that isn't a serialized identity passes through unchanged", () => {
    expect(repoLabel("not-an-identity")).toBe("not-an-identity");
  });
});
