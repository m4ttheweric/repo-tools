/**
 * `rt settings set rt.hooks ... --repo <name>` regenerates that repo's
 * hooks.json derived cache (commands/settings-keys.ts's regen seam,
 * mirroring the intercepts one — see lib/endpoint/__tests__/settings-regen.test.ts).
 *
 * Exercises `settingsSet` directly rather than through a spawned CLI: its
 * happy path never calls `process.exit` (only argument-error branches do),
 * so it's safe to call in-process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoDataDir } from "../../lib/rt-paths.ts";
import { closeStateDb, setKvValue } from "../../lib/state/index.ts";
import { hooksConfigPath } from "../hooks.ts";
import { settingsSet } from "../settings-keys.ts";

const REMOTE = "git@gitlab.com:fake/hooks-regen-repo.git";

describe("rt settings set rt.hooks --repo -> hooks.json regeneration seam", () => {
  const origHome = process.env.HOME;
  let home: string;
  let repoPath: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-hooks-regen-")));
    process.env.HOME = home;
    closeStateDb();
    repoPath = realpathSync(mkdtempSync(join(tmpdir(), "rt-hooks-regen-repo-")));
    execSync("git init -q", { cwd: repoPath });
    execSync(`git remote add origin ${REMOTE}`, { cwd: repoPath });
    mkdirSync(join(repoPath, ".husky"));
    writeFileSync(join(repoPath, ".husky", "pre-commit"), "");
    setKvValue("repo-index", "hooks-regen-repo", repoPath);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });

  test("regenerates the target repo's hooks.json cache to match the just-written value", async () => {
    await settingsSet([
      "rt.hooks",
      '{"enabled":false,"hooks":{}}',
      "--scope",
      "machine",
      "--repo",
      "hooks-regen-repo",
    ]);

    const cache = JSON.parse(readFileSync(hooksConfigPath(repoDataDir("hooks-regen-repo")), "utf8"));
    expect(cache).toEqual({ enabled: false, hooks: { "pre-commit": true } });
  });

  test("a write with no --repo (global scope) does NOT regenerate any repo's cache — the documented gap", async () => {
    await settingsSet(["rt.hooks", '{"enabled":false,"hooks":{}}', "--scope", "user"]);

    expect(() => readFileSync(hooksConfigPath(repoDataDir("hooks-regen-repo")), "utf8")).toThrow();
  });

  test("a set of an unrelated key does not touch hooks.json", async () => {
    await settingsSet(["rt.worktrees", '{"onDeck":1}', "--scope", "machine", "--repo", "hooks-regen-repo"]);

    expect(() => readFileSync(hooksConfigPath(repoDataDir("hooks-regen-repo")), "utf8")).toThrow();
  });
});
