/**
 * The `--repo --worktree <branch>` combo picks a repo via its own inline
 * picker (not lib/pickers.ts's pickFromAllRepos), so a `missing: true` row
 * needs its own guard: refuse via missingRepoRefusal before ever falling
 * into branch resolution against a dead path.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../../lib/state/index.ts";
import { worktreePicker } from "../cd.ts";

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
 * pickFromAllRepos through commands/cd.ts's own `getKnownRepos()` call —
 * before RT-63/68's carry-forward fix, that call excluded missing rows, so a
 * lost repo silently vanished from the picker instead of hitting the
 * missingRepoRefusal guard pickFromAllRepos already carries.
 */
describe("rt cd default picker with a missing repo", () => {
  const origHome = process.env.HOME;
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
