/**
 * The `rt settings set` → intercepts.json regeneration seam (RT-47 Task 7).
 *
 * The hook itself lives in commands/settings-keys.ts (the writer knows a write
 * happened; lib/endpoint must not import a command module) and is exported so
 * this can exercise it without going through `settingsSet`, which exits the
 * process on any argument error.
 *
 * Fresh HOME per test — this writes real store files, a real repos.json and a
 * real git repo, and asserts on the real intercepts.json.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { rtDir, userSettingsPath } from "../../rt-paths.ts";
import { interceptsPath, loadInterceptRules } from "../shim.ts";
import { regenerateInterceptsCache } from "../../../commands/settings-keys.ts";

const REMOTE = "git@gitlab.com:fake/regen-repo.git";
const IDENTITY = "gitlab.com/fake/regen-repo";

describe("regenerateInterceptsCache", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-regen-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  function write(file: string, obj: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
  }

  function registerRepo(): void {
    const repoPath = mkdtempSync(join(tmpdir(), "rt-regen-repo-"));
    execSync("git init -q", { cwd: repoPath });
    execSync(`git remote add origin ${REMOTE}`, { cwd: repoPath });
    write(join(rtDir(), "repos.json"), { "regen-repo": repoPath });
  }

  test("a set of rt.intercepts rebuilds intercepts.json from the stores", async () => {
    registerRepo();
    write(userSettingsPath(), {
      repos: {
        [IDENTITY]: { "rt.intercepts": [{ command: "regencmd", matches: [{ cwdGlob: ".", role: "web" }] }] },
      },
    });

    const result = await regenerateInterceptsCache("rt.intercepts");
    expect(result).toEqual({ regenerated: true, rules: 1 });
    expect(loadInterceptRules()).toEqual([{
      command: "regencmd",
      repo: "regen-repo",
      repoRemote: REMOTE,
      matches: [{ cwdGlob: ".", role: "web" }],
    }]);
  });

  test("a set of rt.roles regenerates too (a role rename changes which rules resolve)", async () => {
    registerRepo();
    write(userSettingsPath(), {
      repos: {
        [IDENTITY]: { "rt.intercepts": [{ command: "rolecmd", matches: [{ cwdGlob: ".", role: "web" }] }] },
      },
    });

    const result = await regenerateInterceptsCache("rt.roles");
    expect(result.regenerated).toBe(true);
    expect(loadInterceptRules().map((r) => r.command)).toEqual(["rolecmd"]);
  });

  test("any other key regenerates nothing and writes no cache file", async () => {
    registerRepo();
    expect(await regenerateInterceptsCache("rt.worktrees")).toEqual({ regenerated: false });
    expect(await regenerateInterceptsCache("rt.hooks")).toEqual({ regenerated: false });
    expect(loadInterceptRules()).toEqual([]);
    expect(Bun.file(interceptsPath()).size).toBe(0); // never created
  });

  test("a regen failure is reported, never thrown (the set already succeeded)", async () => {
    // repos.json points at a path that is not a git repo AND is not readable as
    // one; the build still succeeds with zero rules. The failure channel is
    // exercised by pointing repos.json at a directory that cannot be read as
    // JSON — readJson degrades — so instead force the write to fail by making
    // ~/.mattstack/rt/intercepts.json a directory.
    registerRepo();
    write(userSettingsPath(), {
      repos: {
        [IDENTITY]: { "rt.intercepts": [{ command: "failcmd", matches: [{ cwdGlob: ".", role: "web" }] }] },
      },
    });
    mkdirSync(interceptsPath(), { recursive: true });

    const result = await regenerateInterceptsCache("rt.intercepts");
    expect(result.regenerated).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
