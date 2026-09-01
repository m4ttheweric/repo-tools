/**
 * The `--repo --worktree <branch>` combo picks a repo via its own inline
 * picker (not lib/pickers.ts's pickFromAllRepos), so a `missing: true` row
 * needs its own guard: refuse via missingRepoRefusal before ever falling
 * into branch resolution against a dead path.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../../lib/state/index.ts";
import { worktreePicker } from "../cd.ts";
import { __test__ as pickImplTest, type PickImpl } from "../../lib/ui/pick.ts";

// Satisfies ensureShellFunction()'s early-return check so worktreePicker
// never reaches the interactive "install rt cd?" prompt.
const UP_TO_DATE_RC = 'rt() {\n  whence -p rt\n  "$rt_bin" nav\n}\n';

describe("rt cd --repo --worktree with a missing repo", () => {
  const origHome = process.env.HOME;
  const origShell = process.env.SHELL;
  const origCwd = process.cwd();
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-missing-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-missing-repos-")));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    writeFileSync(join(home, ".zshrc"), UP_TO_DATE_RC);
    closeStateDb();
    // cwd must NOT be a git repo: getRepoIdentity()'s real getRepoRoot() runs
    // "git rev-parse --show-toplevel" against process.cwd() with no override,
    // and if it found one it would auto-register it into this isolated
    // index (updateRepoIndex's side effect), giving repoChoices a second,
    // live entry and forcing the interactive picker instead of the
    // single-entry auto-select this test exercises.
    process.chdir(scratch);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    process.env.SHELL = origShell;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  test("refuses with missingRepoRefusal instead of falling into branch resolution", async () => {
    setKvValue("repo-index", "moved", join(scratch, "gone-away"));

    const originalStdoutWrite = process.stdout.write;
    const chdirSpy = spyOn(process, "chdir").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit sentinel");
    });

    try {
      await expect(worktreePicker(["--repo", "--worktree", "anybranch"])).rejects.toThrow(
        "process.exit sentinel",
      );
      expect(chdirSpy).not.toHaveBeenCalled();
      expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("rt repos locate");
    } finally {
      process.stdout.write = originalStdoutWrite;
      chdirSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

/**
 * The plain `rt cd` picker (no --repo/--worktree flags) reaches
 * pickFromAllRepos through commands/cd.ts's own `getKnownRepos()` call — a
 * bare call there excludes missing rows, so a lost repo would silently vanish
 * from the picker instead of hitting the missingRepoRefusal guard
 * pickFromAllRepos already carries.
 */
describe("rt cd default picker with a missing repo", () => {
  const origHome = process.env.HOME;
  const origShell = process.env.SHELL;
  const origCwd = process.cwd();
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-default-missing-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-default-missing-repos-")));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    writeFileSync(join(home, ".zshrc"), UP_TO_DATE_RC);
    closeStateDb();
    // Not a git repo — see the comment in the describe block above for why
    // this matters (getRepoIdentity() must not auto-register process.cwd()).
    process.chdir(scratch);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    process.env.SHELL = origShell;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  test("the only known repo being missing refuses instead of silently dropping it from the picker", async () => {
    setKvValue("repo-index", "moved", join(scratch, "gone-away"));

    const originalStdoutWrite = process.stdout.write;
    const chdirSpy = spyOn(process, "chdir").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit sentinel");
    });

    try {
      await expect(worktreePicker([])).rejects.toThrow("process.exit sentinel");
      expect(chdirSpy).not.toHaveBeenCalled();
      expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("rt repos locate");
    } finally {
      process.stdout.write = originalStdoutWrite;
      chdirSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

/**
 * The `--repo --worktree <branch>` combo's own inline repo picker (cd.ts,
 * not lib/pickers.ts) is one of the two places this file directly calls
 * process.exit(0) on esc -- the shared "aborted" line belongs there too.
 */
describe("rt cd --repo --worktree: esc on the inline repo picker", () => {
  const origHome = process.env.HOME;
  const origShell = process.env.SHELL;
  const origCwd = process.cwd();
  let home: string;
  let scratch: string;
  let repoA: string;
  let repoB: string;

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-esc-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-esc-repos-")));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    writeFileSync(join(home, ".zshrc"), UP_TO_DATE_RC);
    closeStateDb();
    process.chdir(scratch);

    repoA = join(scratch, "repo-a");
    repoB = join(scratch, "repo-b");
    for (const dir of [repoA, repoB]) {
      execFileSync("mkdir", ["-p", dir]);
      git(dir, "init", "-q");
    }
    // Two real, worktree-having repos so the picker has more than one row --
    // with exactly one, cd.ts auto-selects and never opens a picker at all.
    setKvValue("repo-index", "repo-a", repoA);
    setKvValue("repo-index", "repo-b", repoB);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    process.env.SHELL = origShell;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function installCancelPick(): void {
    const impl: PickImpl = () => ({
      update() {},
      modal: async () => null,
      result: Promise.resolve({ t: "result", action: "cancel", value: null, query: "" }),
    });
    pickImplTest.setImpl(impl);
  }

  async function runCapturingExit(isTTY: boolean): Promise<{ exitCode: number | undefined; stderr: string }> {
    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });

    let stderr = "";
    const chdirSpy = spyOn(process, "chdir").mockImplementation(() => {});
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit sentinel");
    });
    try {
      await worktreePicker(["--repo", "--worktree", "anybranch"]);
      return { exitCode: undefined, stderr };
    } catch {
      return { exitCode: exitSpy.mock.calls.at(-1)?.[0] as number | undefined, stderr };
    } finally {
      chdirSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  }

  test("prints the faint 'aborted' line when stderr is a TTY", async () => {
    installCancelPick();
    try {
      const { exitCode, stderr } = await runCapturingExit(true);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("aborted");
    } finally {
      pickImplTest.setImpl(undefined);
    }
  });

  test("prints no 'aborted' decoration off a TTY", async () => {
    installCancelPick();
    try {
      const { exitCode, stderr } = await runCapturingExit(false);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("aborted");
    } finally {
      pickImplTest.setImpl(undefined);
    }
  });
});
