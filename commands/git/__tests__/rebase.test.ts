import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { rebaseOnto } from "../rebase.ts";

let tmpRoot: string;
let savedSyncLogPath: string | undefined;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-rebase-")));
  // rebaseOnto logs every git command via syncLog; redirect it to a temp
  // file so these tests never append to the real ~/.mattstack/rt/sync.log.
  savedSyncLogPath = process.env.RT_SYNC_LOG_PATH;
  process.env.RT_SYNC_LOG_PATH = join(tmpRoot, "sync.log");
});

afterEach(() => {
  if (savedSyncLogPath === undefined) delete process.env.RT_SYNC_LOG_PATH;
  else process.env.RT_SYNC_LOG_PATH = savedSyncLogPath;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

/**
 * Repo where `feature` and `master` both edit line 1 of app.txt,
 * guaranteeing an unresolvable conflict with no auto-resolve rules.
 */
function makeConflictRepo(): string {
  const repo = join(tmpRoot, "repo");
  execSync(`git init -q -b master "${repo}"`);
  const git = (c: string) => sh(`git -c user.email=t@t -c user.name=t ${c}`, repo);
  writeFileSync(join(repo, "app.txt"), "base\n");
  git("add .");
  git('commit -qm "base"');
  git("checkout -qb feature");
  writeFileSync(join(repo, "app.txt"), "feature change\n");
  git('commit -qam "feature edit"');
  git("checkout -q master");
  writeFileSync(join(repo, "app.txt"), "master change\n");
  git('commit -qam "master edit"');
  git("checkout -q feature");
  return repo;
}

function rebaseDirExists(repo: string): boolean {
  return (
    existsSync(join(repo, ".git", "rebase-merge")) ||
    existsSync(join(repo, ".git", "rebase-apply"))
  );
}

describe("rebaseOnto onConflict", () => {
  test("pause leaves the rebase in progress and reports it", async () => {
    const repo = makeConflictRepo();
    const result = await rebaseOnto({
      cwd: repo,
      target: "master",
      skipFetch: true,
      quiet: true,
      onConflict: "pause",
    });
    expect(result.status).toBe("conflict");
    expect(result.rebaseInProgress).toBe(true);
    expect(result.unresolvedFiles).toEqual(["app.txt"]);
    expect(result.backupBranch).toStartWith("rt-backup/rebase/feature/");
    expect(rebaseDirExists(repo)).toBe(true);
  });

  test("default aborts as before", async () => {
    const repo = makeConflictRepo();
    const result = await rebaseOnto({
      cwd: repo,
      target: "master",
      skipFetch: true,
      quiet: true,
    });
    expect(result.status).toBe("conflict");
    expect(result.rebaseInProgress).toBeFalsy();
    expect(rebaseDirExists(repo)).toBe(false);
  });
});
