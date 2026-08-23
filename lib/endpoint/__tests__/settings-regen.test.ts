/**
 * The `rt settings set` → intercepts cache regeneration seam (RT-47 Task 7).
 *
 * The hook itself lives in commands/settings-keys.ts (the writer knows a write
 * happened; lib/endpoint must not import a command module) and is exported so
 * this can exercise it without going through `settingsSet`, which exits the
 * process on any argument error.
 *
 * Fresh HOME per test — this writes real store files, a real repo-index
 * entry, and a real git repo, and asserts on the real intercepts store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { rtDir, userSettingsPath } from "../../rt-paths.ts";
import { closeStateDb, getStateDb, setKvValue } from "../../state/index.ts";
import { loadInterceptRules } from "../shim.ts";
import { regenerateInterceptsCache } from "../../../commands/settings-keys.ts";

const REMOTE = "git@gitlab.com:fake/regen-repo.git";
const IDENTITY = "gitlab.com/fake/regen-repo";

describe("regenerateInterceptsCache", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-regen-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
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
    setKvValue("repo-index", "regen-repo", repoPath);
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

  test("any other key regenerates nothing and writes no cache", async () => {
    registerRepo();
    expect(await regenerateInterceptsCache("rt.worktrees")).toEqual({ regenerated: false });
    expect(await regenerateInterceptsCache("rt.hooks")).toEqual({ regenerated: false });
    expect(loadInterceptRules()).toEqual([]); // fallback — never written
  });

  test("a regen failure is reported, never thrown (the set already succeeded)", async () => {
    registerRepo();
    write(userSettingsPath(), {
      repos: {
        [IDENTITY]: { "rt.intercepts": [{ command: "failcmd", matches: [{ cwdGlob: ".", role: "web" }] }] },
      },
    });

    // Force the underlying store write to fail: materialize state.db once,
    // then strip all permissions so the next open throws instead of
    // quarantining (quarantine only fires for corruption, not permission
    // errors) — a real-world "can't touch the db" failure, not a directory
    // masquerading as the old JSON file.
    getStateDb();
    closeStateDb();
    chmodSync(join(rtDir(), "state.db"), 0o000);

    try {
      const result = await regenerateInterceptsCache("rt.intercepts");
      expect(result.regenerated).toBe(false);
      expect(result.error).toBeTruthy();
    } finally {
      chmodSync(join(rtDir(), "state.db"), 0o600); // afterEach's rmSync needs read access
    }
  });
});
