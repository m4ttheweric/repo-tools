import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { branchForCwd, repoForCwd, resolveMainWorktreePath } from "../repo-for-cwd.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "rt-repo-for-cwd-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function mainRepo(name: string): string {
  const path = join(root, name);
  mkdirSync(join(path, ".git", "worktrees"), { recursive: true });
  return path;
}

test("a main worktree resolves to its own alias", () => {
  const main = mainRepo("acme");
  mkdirSync(join(main, "src"));
  expect(repoForCwd(join(main, "src"), { "remote:gitlab.com%2Facme%2Facme": main })).toBe("acme");
});

test("a linked worktree resolves through its .git file to the main repo's alias", () => {
  const main = mainRepo("acme");
  mkdirSync(join(main, ".git", "worktrees", "wt-1"));
  const linked = join(root, "acme-wt-1");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt-1")}\n`);
  expect(resolveMainWorktreePath(linked)).toBe(main);
  expect(repoForCwd(linked, { "remote:gitlab.com%2Facme%2Facme": main })).toBe("acme");
});

test("a directory outside any repo resolves to null", () => {
  const stray = join(root, "stray");
  mkdirSync(stray);
  expect(repoForCwd(stray, {})).toBeNull();
});

test("branchForCwd reads the branch through an injected async exec and never throws", async () => {
  const exec = async () => ({ stdout: "feat/x\n", stderr: "", exitCode: 0 });
  expect(await branchForCwd("/anywhere", exec)).toBe("feat/x");
  const failing = async () => ({ stdout: "", stderr: "", exitCode: 128 });
  expect(await branchForCwd("/anywhere", failing)).toBeUndefined();
});
