import { beforeEach, describe, expect, test } from "bun:test";
import { hasCommits, hasRemote, isGitRepo, originPushState, resetCltCacheForTests } from "../home-git.ts";
import type { Probes } from "../probes.ts";

type Result = { code: number; stdout: string; stderr: string };
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (code = 2): Result => ({ code, stdout: "", stderr: "" });

function scriptedExec(script: (argv: string[]) => Result): { exec: Probes["exec"]; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Probes["exec"] = async (argv) => {
    calls.push(argv);
    return script(argv);
  };
  return { exec, calls };
}

beforeEach(() => resetCltCacheForTests());

describe("home-git without command line tools", () => {
  // The /usr/bin/git stub pops Apple's "install the developer tools?" dialog
  // when a GUI process (the tray's status poll) invokes it — so no helper
  // here may run git until xcode-select reports a developer dir.
  test("every probe answers its no-git shape and git is NEVER exec'd", async () => {
    const { exec, calls } = scriptedExec((argv) => (argv[0] === "xcode-select" ? fail() : ok("true\n")));

    expect(await isGitRepo(exec, "/home/user")).toBe(false);
    expect(await hasRemote(exec, "/home/user")).toBe(false);
    expect(await hasCommits(exec, "/home/user")).toBe(false);
    expect(await originPushState(exec, "/home/user")).toEqual({ kind: "unknown" });
    expect(calls.every((argv) => argv[0] !== "git")).toBe(true);
  });

  test("CLT arriving mid-session is picked up — only the positive is cached", async () => {
    let cltInstalled = false;
    const { exec, calls } = scriptedExec((argv) => {
      if (argv[0] === "xcode-select") return cltInstalled ? ok("/Library/Developer/CommandLineTools\n") : fail();
      return ok("true\n");
    });

    expect(await isGitRepo(exec, "/home/user")).toBe(false);
    cltInstalled = true;
    expect(await isGitRepo(exec, "/home/user")).toBe(true);
    // A later call rides the cached positive: no second xcode-select probe.
    const probesBefore = calls.filter((a) => a[0] === "xcode-select").length;
    expect(await hasCommits(exec, "/home/user")).toBe(true);
    expect(calls.filter((a) => a[0] === "xcode-select").length).toBe(probesBefore);
  });
});

describe("home-git with command line tools", () => {
  test("probes run git and report its answers", async () => {
    const { exec } = scriptedExec((argv) => {
      if (argv[0] === "xcode-select") return ok("/Library/Developer/CommandLineTools\n");
      if (argv.includes("--is-inside-work-tree")) return ok("true\n");
      if (argv[1] === "remote") return ok("origin\n");
      return ok();
    });
    expect(await isGitRepo(exec, "/home/user")).toBe(true);
    expect(await hasRemote(exec, "/home/user")).toBe(true);
  });
});
