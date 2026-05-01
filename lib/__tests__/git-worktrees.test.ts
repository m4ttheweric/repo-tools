import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { listWorktreeRoots } from "../git-worktrees.ts";

let tmpRoot: string;

beforeEach(() => {
  // Resolve symlinks (macOS /var → /private/var) so paths match what
  // `git worktree list --porcelain` returns.
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-git-worktrees-")));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function initRepo(path: string): void {
  execSync(`git init -q "${path}"`);
  // git refuses worktree operations on a repo with no commits.
  writeFileSync(join(path, "README"), "x");
  execSync(`git -C "${path}" add . && git -C "${path}" -c user.email=t@t -c user.name=t commit -q -m init`);
}

describe("listWorktreeRoots", () => {
  test("returns empty array for a non-git directory", () => {
    expect(listWorktreeRoots(tmpRoot)).toEqual([]);
  });

  test("returns the primary worktree path for a fresh repo", () => {
    const repo = mkdtempSync(join(tmpRoot, "repo-"));
    initRepo(repo);
    expect(listWorktreeRoots(repo)).toEqual([repo]);
  });

  test("includes added linked worktrees", () => {
    const repo = mkdtempSync(join(tmpRoot, "repo-"));
    initRepo(repo);
    const linked = join(tmpRoot, "linked");
    execSync(`git -C "${repo}" worktree add -q "${linked}" -b feat/x`);
    expect(listWorktreeRoots(repo).sort()).toEqual([linked, repo].sort());
  });

  test("filters out worktrees whose directory was removed externally", () => {
    const repo = mkdtempSync(join(tmpRoot, "repo-"));
    initRepo(repo);
    const linked = join(tmpRoot, "linked-removed");
    execSync(`git -C "${repo}" worktree add -q "${linked}" -b feat/y`);
    rmSync(linked, { recursive: true, force: true });
    // Git still lists the worktree in porcelain output until pruned;
    // listWorktreeRoots must filter the missing dir out.
    expect(listWorktreeRoots(repo)).toEqual([repo]);
  });
});
