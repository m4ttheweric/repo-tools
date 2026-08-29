import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listWorktreeRootsAsync } from "../worktree/git-async.ts";
import { runGit } from "../worktree/git-async.ts";

test("listWorktreeRootsAsync returns the main worktree path", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-wt-")));
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["commit", "--allow-empty", "-m", "init", "-c", "user.email=a@b.c", "-c", "user.name=t"]);
  const roots = await listWorktreeRootsAsync(dir);
  expect(roots).toContain(dir);
});

test("listWorktreeRootsAsync returns [] on a non-repo", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-nonrepo-")));
  expect(await listWorktreeRootsAsync(dir)).toEqual([]);
});
