import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { snapshotWorktree } from "../snapshot.ts";

let tmpRoot: string;
let repo: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-snapshot-")));
  repo = join(tmpRoot, "repo");
  mkdirSync(repo);
  execSync(`git init -q "${repo}"`);
  execSync(`git -C "${repo}" config user.email t@t && git -C "${repo}" config user.name t`);
  writeFileSync(join(repo, "base.txt"), "base\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  execSync(`git -C "${repo}" add . && git -C "${repo}" commit -q -m init`);
  // Simulate the fetched remote branch the merge-base is computed against.
  execSync(`git -C "${repo}" update-ref refs/remotes/origin/master HEAD`);
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function g(args: string): string {
  return execSync(`git -C "${repo}" ${args}`, { encoding: "utf8" }).trim();
}

describe("snapshotWorktree", () => {
  test("captures staged, unstaged, and untracked-not-ignored files", async () => {
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    g("add staged.txt");
    writeFileSync(join(repo, "base.txt"), "unstaged edit\n"); // tracked, not staged
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");
    writeFileSync(join(repo, "ignored.txt"), "ignored\n");

    const snap = await snapshotWorktree(repo);

    expect(g(`show ${snap.commit}:staged.txt`)).toBe("staged");
    expect(g(`show ${snap.commit}:base.txt`)).toBe("unstaged edit");
    expect(g(`show ${snap.commit}:untracked.txt`)).toBe("untracked");
    const names = g(`ls-tree -r --name-only ${snap.commit}`).split("\n");
    expect(names).not.toContain("ignored.txt");
  });

  test("never touches HEAD, index, or worktree", async () => {
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    g("add staged.txt");
    writeFileSync(join(repo, "base.txt"), "unstaged edit\n");
    writeFileSync(join(repo, "untracked.txt"), "untracked\n");

    const headBefore = g("rev-parse HEAD");
    const statusBefore = g("status --porcelain=v1");

    await snapshotWorktree(repo);

    expect(g("rev-parse HEAD")).toBe(headBefore);
    expect(g("status --porcelain=v1")).toBe(statusBefore);
  });

  test("snapshot commit's parent is the worktree's HEAD", async () => {
    writeFileSync(join(repo, "untracked.txt"), "x\n");
    const snap = await snapshotWorktree(repo);
    expect(g(`rev-parse ${snap.commit}^`)).toBe(g("rev-parse HEAD"));
  });

  test("identical content produces an identical tree sha", async () => {
    writeFileSync(join(repo, "base.txt"), "edit\n");
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const first = await snapshotWorktree(repo);
    const second = await snapshotWorktree(repo);
    expect(second.tree).toBe(first.tree);
  });

  test("changed content produces a different tree sha", async () => {
    const first = await snapshotWorktree(repo);
    writeFileSync(join(repo, "base.txt"), "changed\n");
    const second = await snapshotWorktree(repo);
    expect(second.tree).not.toBe(first.tree);
  });

  test("changedFiles is diffed against the snapshot commit, so uncommitted edits count", async () => {
    // One committed change past origin/master…
    writeFileSync(join(repo, "committed.txt"), "c\n");
    g("add committed.txt");
    g("commit -q -m feat");
    // …plus an uncommitted tracked edit and an untracked file.
    writeFileSync(join(repo, "base.txt"), "uncommitted edit\n");
    writeFileSync(join(repo, "untracked.txt"), "u\n");

    const snap = await snapshotWorktree(repo);

    expect(snap.mergeBase).toBe(g("rev-parse refs/remotes/origin/master"));
    expect(snap.changedFiles).toContain("committed.txt");
    expect(snap.changedFiles).toContain("base.txt");
    expect(snap.changedFiles).toContain("untracked.txt");
  });

  test("resolves the worktree root when called from a subdirectory", async () => {
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const sub = join(repo, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "nested.txt"), "n\n");

    const snap = await snapshotWorktree(sub);

    const names = g(`ls-tree -r --name-only ${snap.commit}`).split("\n");
    expect(names).toContain("untracked.txt");
    expect(names).toContain("sub/nested.txt");
  });
});
