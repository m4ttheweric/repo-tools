/**
 * Trashed trees must never surface as picker-eligible worktrees. Normally
 * dispose's `git worktree prune` removes the admin entry, but the rename into
 * the retention store and the prune are two steps: a daemon death between them
 * leaves git still listing a path under `.trash/`. The index build is the seam
 * every picker (live or cache-served) reads through, so the exclusion lives
 * there.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { getKnownRepos, getKnownReposAsync } from "../repo-index.ts";

const REPO_INDEX_NS = "repo-index";

describe("repo-index — trashed trees are not worktrees", () => {
  const origHome = process.env.HOME;
  let home: string;
  let repo: string;

  function sh(cmd: string, cwd: string): void {
    execSync(cmd, { cwd, stdio: "pipe" });
  }

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-trashidx-home-")));
    process.env.HOME = home;
    closeStateDb();

    // Nested under the isolated HOME: the index infers scan roots from each
    // known repo's parent dir, and a fixture sitting directly in the OS temp
    // dir makes it enumerate the machine's entire temp tree.
    repo = join(home, "repos", "trashidx");
    mkdirSync(repo, { recursive: true });
    sh("git init -q -b main", repo);
    sh("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", repo);
    sh(`git worktree add -q -b rt-live ${join(repo, ".worktrees", "alpha")}`, repo);
    sh(`git worktree add -q -b rt-stale ${join(repo, ".worktrees", ".trash", "bravo-1725000000000")}`, repo);
    setKvValue(REPO_INDEX_NS, "trashidx", repo);
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("getKnownRepos drops a git-listed tree sitting under .trash/", () => {
    const row = getKnownRepos().find((r) => r.repoName === "trashidx");
    const paths = row!.worktrees.map((w) => w.path);
    expect(paths).toContain(join(repo, ".worktrees", "alpha"));
    expect(paths.some((p) => p.includes(".trash"))).toBe(false);
  });

  test("getKnownReposAsync applies the same exclusion", async () => {
    const row = (await getKnownReposAsync()).find((r) => r.repoName === "trashidx");
    const paths = row!.worktrees.map((w) => w.path);
    expect(paths).toContain(join(repo, ".worktrees", "alpha"));
    expect(paths.some((p) => p.includes(".trash"))).toBe(false);
  });
});
