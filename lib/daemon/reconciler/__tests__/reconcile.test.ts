import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb } from "../../../state/index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../../../worktree/registry.ts";
import { reconcileRepo } from "../reconcile.ts";

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtreconcile-")));
  execSync(
    "git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: dir, shell: "/bin/zsh" },
  );
  return dir;
}

describe("reconcile.ts: reconcileRepo", () => {
  const repoName = "acme";
  let repo: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtreconcile-home-")));
    closeStateDb();
    repo = makeRepo();
  });

  test("adopts the main clone into an empty registry", async () => {
    const trees = await reconcileRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });

    expect(trees.length).toBe(1);
    expect(trees[0]!.kind).toBe("main");
    expect(loadRegistry(repoName).length).toBe(1);
  });

  test("prunes a registered tree missing from git after MISSING_PRUNE_PASSES misses", async () => {
    const ghost: TreeRecord = {
      name: "ghost",
      path: join(repo, ".worktrees", "ghost"),
      kind: "ephemeral",
      state: "on-deck",
      branch: "feat-ghost",
      createdAt: new Date().toISOString(),
    };
    saveRegistry(repoName, [ghost]);

    for (let i = 0; i < 3; i++) {
      await reconcileRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });
    }

    expect(loadRegistry(repoName).find((t) => t.name === "ghost")).toBeUndefined();
  });
});
