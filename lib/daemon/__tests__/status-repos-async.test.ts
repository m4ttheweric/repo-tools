/**
 * S055: "repos" used the sync `listWorktrees` (lib/git-worktrees.ts,
 * execSync) on the daemon's event loop. Swapped for the async
 * `listWorktreesAsync` (lib/worktree/git-async.ts, already used elsewhere
 * in the daemon).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStatusHandlers } from "../handlers/status.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-status-repos-")));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function initRepo(path: string): void {
  execSync(`git init -q "${path}"`);
  writeFileSync(join(path, "README"), "x");
  execSync(`git -C "${path}" add . && git -C "${path}" -c user.email=t@t -c user.name=t commit -q -m init`);
}

function fakeCtx(repos: Record<string, string>): any {
  return {
    startedAt: 123,
    identity: { flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 },
    watchedConfigs: new Map(),
    cache: { entries: {} },
    portCacheRef: { ports: [], updatedAt: null },
    repoIndex: () => repos,
  };
}

describe("status handlers — repos (S055 async worktree listing)", () => {
  test("lists worktrees with a branch, omitting detached ones", async () => {
    const repo = mkdtempSync(join(tmpRoot, "repo-"));
    initRepo(repo);
    const linked = join(tmpRoot, "linked");
    execSync(`git -C "${repo}" worktree add -q "${linked}" -b feat/x`);

    const h = createStatusHandlers(fakeCtx({ myrepo: repo }));
    const res = (await h["repos"]!({}, undefined as any)) as any;

    expect(res.ok).toBe(true);
    const worktrees = res.data.repos.myrepo.worktrees;
    expect(worktrees.map((w: any) => w.path).sort()).toEqual([linked, repo].sort());
    expect(worktrees.every((w: any) => typeof w.branch === "string" && w.branch.length > 0)).toBe(true);
  });

  test("a repo whose git command fails (bad repoPath) yields no worktrees, not a throw", async () => {
    const notARepo = mkdtempSync(join(tmpRoot, "not-a-repo-"));
    const h = createStatusHandlers(fakeCtx({ broken: notARepo }));
    const res = (await h["repos"]!({}, undefined as any)) as any;
    expect(res.ok).toBe(true);
    expect(res.data.repos.broken.worktrees).toEqual([]);
  });
});
