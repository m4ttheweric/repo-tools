import { describe, expect, test } from "bun:test";

import { sandboxShipRef, shipSandbox, type GitRun, type ShipSummary } from "../sandbox-ship.ts";

interface GitCall {
  argv: string[];
  cwd: string;
  env: Record<string, string> | undefined;
}

function fakeGit(script: Record<string, { stdout?: string; exitCode?: number }>) {
  const calls: GitCall[] = [];
  const run: GitRun = async (argv, opts) => {
    calls.push({ argv: [...argv], cwd: opts.cwd, env: opts.env });
    for (const [prefix, result] of Object.entries(script)) {
      if (argv.join(" ").startsWith(prefix)) {
        return { stdout: result.stdout ?? "", stderr: "", exitCode: result.exitCode ?? 0 };
      }
    }
    return { stdout: "", stderr: "unscripted", exitCode: 127 };
  };
  return { run, calls };
}

function world(opts: { confirm: boolean; fetchExit?: number } = { confirm: true }) {
  const { run, calls } = fakeGit({
    "git fetch": { exitCode: opts.fetchExit ?? 0 },
    "git rev-parse FETCH_HEAD": { stdout: "abc123def\n" },
    "git merge-base": { stdout: "base456\n" },
    "git log": { stdout: "abc123 fix the thing\n" },
    "git diff": { stdout: " 2 files changed, 10 insertions(+)\n" },
    "git push": { exitCode: 0 },
  });
  const confirms: ShipSummary[] = [];
  return {
    calls,
    confirms,
    ship: () => shipSandbox({
      repoId: "acme-dev",
      sandboxId: "sb-1",
      branch: "cv-1-fix",
      baseRef: "refs/remotes/origin/master",
      cwd: "/work",
      git: run,
      confirm: async (summary) => {
        confirms.push(summary);
        return opts.confirm;
      },
      env: { MC_RECEIVER_SSH_KEY: "/key" },
    }),
  };
}

describe("shipSandbox", () => {
  test("ship ref namespace keeps agent output out of the mirror's branches", () => {
    expect(sandboxShipRef("sb-1", "cv-1-fix")).toBe("refs/sandboxes/sb-1/cv-1-fix");
  });

  test("fetches the sandbox ref from the receiver with the pinned ssh env, summarizes, pushes on confirm", async () => {
    const w = world({ confirm: true });
    const out = await w.ship();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pushed).toBe(true);
      expect(out.summary.commit).toBe("abc123def");
      expect(out.summary.diffstat).toContain("2 files changed");
      expect(out.summary.log).toContain("fix the thing");
    }
    expect(w.calls[0]!.argv).toEqual([
      "git", "fetch", "ssh://git@localhost:2222/repos/acme-dev.git", "refs/sandboxes/sb-1/cv-1-fix",
    ]);
    expect(w.calls[0]!.cwd).toBe("/work");
    expect(w.calls[0]!.env?.GIT_SSH_COMMAND).toContain("/key");
    // The push happens under the operator's LOCAL identity — plain push to
    // origin, no receiver ssh pinning in its env.
    const push = w.calls.at(-1)!;
    expect(push.argv).toEqual(["git", "push", "origin", "FETCH_HEAD:refs/heads/cv-1-fix"]);
    expect(push.env?.GIT_SSH_COMMAND).toBeUndefined();
  });

  test("THE GATE: declining the confirmation pushes nothing", async () => {
    const w = world({ confirm: false });
    const out = await w.ship();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.pushed).toBe(false);
    expect(w.confirms).toHaveLength(1); // the summary was shown
    expect(w.calls.some(c => c.argv[1] === "push")).toBe(false); // nothing left the machine
  });

  test("a failed receiver fetch never reaches the confirmation", async () => {
    const w = world({ confirm: true, fetchExit: 1 });
    const out = await w.ship();
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain("fetch");
    expect(w.confirms).toHaveLength(0);
    expect(w.calls.some(c => c.argv[1] === "push")).toBe(false);
  });

  test("a summary command failure aborts before the confirmation, not after", async () => {
    const { run, calls } = fakeGit({
      "git fetch": { exitCode: 0 },
      "git rev-parse FETCH_HEAD": { exitCode: 128 },
    });
    const out = await shipSandbox({
      repoId: "r", sandboxId: "s", branch: "b", baseRef: "refs/remotes/origin/master",
      cwd: "/w", git: run,
      confirm: async () => { throw new Error("must not be reached"); },
    });
    expect(out.ok).toBe(false);
    expect(calls.some(c => c.argv[1] === "push")).toBe(false);
  });
});
