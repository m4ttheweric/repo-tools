/**
 * A moved repo's index row must stay visible: hiding it makes the repo look
 * unregistered and re-registers it under a second row at the new path, which
 * is the split `rt repos locate` exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { getKnownRepos, missingRepoRefusal, repoOption } from "../repo-index.ts";
import { pickFromAllRepos } from "../pickers.ts";

describe("missing index rows", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-missing-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-missing-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function realRepo(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return dir;
  }

  test("getKnownRepos() default excludes a row whose path is gone", () => {
    setKvValue("repo-index", "moved", join(scratch, "gone-away"));

    expect(getKnownRepos().find((r) => r.repoName === "moved")).toBeUndefined();
  });

  test("getKnownRepos({ includeMissing: true }) surfaces that same row, marked missing", () => {
    setKvValue("repo-index", "moved", join(scratch, "gone-away"));

    const row = getKnownRepos({ includeMissing: true }).find((r) => r.repoName === "moved");

    expect(row?.missing).toBe(true);
    expect(row?.worktrees[0]?.path).toBe(join(scratch, "gone-away"));
  });

  test("a live row is never marked missing, even with includeMissing: true", () => {
    setKvValue("repo-index", "alive", realRepo("alive"));

    expect(getKnownRepos({ includeMissing: true }).find((r) => r.repoName === "alive")?.missing).toBeUndefined();
  });

  test("two lost rows for one directory collapse to a single missing entry", () => {
    setKvValue("repo-index", "legacy-name", join(scratch, "gone-away"));
    setKvValue("repo-index", "remote:gitlab.com%2Fg%2Fgone", join(scratch, "gone-away"));

    expect(getKnownRepos({ includeMissing: true }).filter((r) => r.missing).length).toBe(1);
  });

  test("a lost legacy-named row does not shadow a scanned directory of the same basename", () => {
    // The live anchor is what makes `scratch` an inferred scan root; the lost
    // row is the pre-cutover legacy name, which is the moved folder's basename.
    setKvValue("repo-index", "remote:gitlab.com%2Fg%2Fanchor", realRepo("anchor"));
    setKvValue("repo-index", "mu", join(scratch, "nest", "mu"));
    const moved = realRepo("mu");

    const scanned = getKnownRepos({ includeMissing: true })
      .filter((r) => r.registered === false)
      .map((r) => r.worktrees[0]?.path);

    expect(scanned).toContain(moved);
  });

  test("the picker row says what to run", () => {
    const opt = repoOption({ repoName: "moved", worktrees: [{ path: "/x/gone", branch: "", isBare: false }], dataDir: "/d", missing: true });
    expect(opt.hint).toBe("missing — rt repos locate");
    expect(opt.color).toBeDefined();
  });

  test("the refusal names the repo, the gone path, and the fix", () => {
    const msg = missingRepoRefusal({ repoName: "moved", worktrees: [{ path: "/x/gone", branch: "", isBare: false }], dataDir: "/d", missing: true });
    expect(msg).toContain("/x/gone");
    expect(msg).toContain("rt repos locate");
    expect(msg).toContain("--repo moved");
  });

  test("pickFromAllRepos refuses to cd into a missing repo instead of auto-selecting it", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit sentinel");
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await pickFromAllRepos(
        [{ repoName: "moved", worktrees: [{ path: "/x/gone", branch: "", isBare: false }], dataDir: "/d", missing: true }],
        { stderr: true },
      );
      throw new Error("expected pickFromAllRepos to exit");
    } catch (err) {
      expect((err as Error).message).toBe("process.exit sentinel");
      expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("rt repos locate");
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
