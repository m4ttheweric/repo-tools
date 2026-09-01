import { test, expect } from "bun:test";
import { join } from "path";
import { worktreesDir, worktreePoolRoot, rtDir } from "../../rt-paths.ts";
import { loadWorktreeRepoConfig } from "../config.ts";
import { serializeIdentity, deriveRepoIdentity } from "../../settings/identity.ts";

test("worktreePoolRoot lives under rtDir/worktrees keyed by the PATH-safe identity segment", () => {
  const id = "remote:gitlab.com%2Facme%2Facme-dev";
  expect(worktreesDir()).toBe(join(rtDir(), "worktrees"));
  expect(worktreePoolRoot(id)).toBe(join(rtDir(), "worktrees", "remote%3Agitlab.com%2Facme%2Facme-dev"));
});

test("default worktrees.root is the out-of-repo pool root", async () => {
  const repoPath = process.cwd(); // a real git repo (this worktree)
  const cfg = await loadWorktreeRepoConfig("repo-tools", repoPath);
  const id = serializeIdentity(await deriveRepoIdentity(repoPath));
  expect(cfg.root).toBe(worktreePoolRoot(id));
});
