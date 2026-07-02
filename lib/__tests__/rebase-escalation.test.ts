import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { rebaseOnto, type RebaseResult } from "../../commands/git/rebase.ts";
import {
  buildConflictBundle,
  renderAgentTask,
  renderHumanReport,
  verifyRebaseCompleted,
  writeTaskFile,
} from "../rebase-escalation.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-escalation-")));
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

function sh(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

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

async function pausedConflict(repo: string): Promise<RebaseResult> {
  return rebaseOnto({
    cwd: repo,
    target: "master",
    skipFetch: true,
    quiet: true,
    onConflict: "pause",
  });
}

describe("buildConflictBundle", () => {
  test("reads branch commits from the branch ref, not detached HEAD", async () => {
    const repo = makeConflictRepo();
    const result = await pausedConflict(repo);
    const bundle = buildConflictBundle(result, repo);

    expect(bundle.kind).toBe("rebase-conflict");
    expect(bundle.state).toBe("mid-rebase");
    expect(bundle.branch).toBe("feature");
    expect(bundle.target).toBe("master");
    expect(bundle.unresolvedFiles).toEqual(["app.txt"]);
    // Mid-rebase HEAD is detached on the target side; the branch ref must
    // still yield the branch's own commit, and only that commit.
    expect(bundle.branchCommits).toHaveLength(1);
    expect(bundle.branchCommits[0]).toContain("feature edit");
    expect(bundle.targetCommits).toHaveLength(1);
    expect(bundle.targetCommits[0]).toContain("master edit");
    expect(bundle.backupBranch).toStartWith("rt-backup/rebase/feature/");
  });
});

describe("renderAgentTask", () => {
  test("contains the worktree, files, both intents, and the safety rules", async () => {
    const repo = makeConflictRepo();
    const bundle = buildConflictBundle(await pausedConflict(repo), repo);
    const task = renderAgentTask(bundle, repo);

    expect(task).toContain(repo);
    expect(task).toContain("app.txt");
    expect(task).toContain("feature edit");
    expect(task).toContain("master edit");
    expect(task).toContain("git rebase --continue");
    expect(task).toContain("Do NOT push");
    expect(task).toContain(bundle.backupBranch!);
  });
});

describe("renderHumanReport", () => {
  test("mid-rebase report explains continue and abort", async () => {
    const repo = makeConflictRepo();
    const bundle = buildConflictBundle(await pausedConflict(repo), repo);
    const report = renderHumanReport(bundle);
    expect(report).toContain("app.txt");
    expect(report).toContain("git rebase --continue");
    expect(report).toContain("git rebase --abort");
  });
});

describe("writeTaskFile", () => {
  test("writes under <dataDir>/agent-tasks and returns the path", () => {
    const dataDir = join(tmpRoot, "data");
    const path = writeTaskFile(dataDir, "task body");
    expect(path).toStartWith(join(dataDir, "agent-tasks"));
    expect(path).toEndWith(".md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("task body");
  });
});

describe("verifyRebaseCompleted", () => {
  test("still-in-progress while the rebase is paused", async () => {
    const repo = makeConflictRepo();
    await pausedConflict(repo);
    expect(verifyRebaseCompleted(repo, "feature", "master")).toBe("still-in-progress");
  });

  test("completed after conflicts are resolved and the rebase continues", async () => {
    const repo = makeConflictRepo();
    await pausedConflict(repo);
    writeFileSync(join(repo, "app.txt"), "merged change\n");
    sh("git add app.txt", repo);
    sh("GIT_EDITOR=true git -c user.email=t@t -c user.name=t rebase --continue", repo);
    expect(verifyRebaseCompleted(repo, "feature", "master")).toBe("completed");
  });

  test("agent-aborted when the rebase was aborted (clean tree, target not ancestor)", async () => {
    const repo = makeConflictRepo();
    await pausedConflict(repo);
    sh("git rebase --abort", repo);
    expect(verifyRebaseCompleted(repo, "feature", "master")).toBe("agent-aborted");
  });

  test("dirty when the tree has uncommitted changes after the rebase", async () => {
    const repo = makeConflictRepo();
    await pausedConflict(repo);
    sh("git rebase --abort", repo);
    writeFileSync(join(repo, "junk.txt"), "leftover\n");
    sh("git add junk.txt", repo);
    expect(verifyRebaseCompleted(repo, "feature", "master")).toBe("dirty");
  });

  test("wrong-branch when the agent switched branches", async () => {
    const repo = makeConflictRepo();
    await pausedConflict(repo);
    sh("git rebase --abort", repo);
    sh("git checkout -q master", repo);
    expect(verifyRebaseCompleted(repo, "feature", "master")).toBe("wrong-branch");
  });
});
