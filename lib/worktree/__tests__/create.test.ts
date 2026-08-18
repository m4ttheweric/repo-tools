import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeJson } from "../../json-store.ts";
import { repoDataDir } from "../../rt-paths.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../registry.ts";
import { branchExistsLocalAsync, listWorktreesAsync } from "../git-async.ts";
import { createTree, scrapTree, type CreateDeps } from "../create.ts";

function makeRepo(): string {
  // realpathSync: git canonicalizes /var -> /private/var on macOS (Global Constraints)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtcreate-")));
  execSync(
    "git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: dir, shell: "/bin/zsh" }
  );
  return dir;
}

/** Bare-clone `repo` as its own "origin" and fetch, so remoteDefaultRef resolves origin/main. */
function addBareOrigin(repo: string): void {
  const bare = mkdtempSync(join(tmpdir(), "rtcreate-bare-"));
  execSync(
    `git clone --bare ${repo} ${bare}/o.git && git -C ${repo} remote add origin ${bare}/o.git && git -C ${repo} fetch origin`,
    { shell: "/bin/zsh" }
  );
}

function makeDeps(repoName: string, repoPath: string, events: Array<{ type: string; data: unknown }>): CreateDeps {
  return {
    repoName,
    repoPath,
    emit: (type, data) => events.push({ type, data }),
    log: { info: () => {}, warn: () => {} },
  };
}

describe("createTree", () => {
  let repo: string;
  let repoName: string;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcreate-home-")));
    repo = makeRepo();
    addBareOrigin(repo);
    repoName = "acme";
    events = [];
  });

  test("happy path: registry ends with one on-deck record on origin default sha", async () => {
    const expectedSha = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();

    const deps = makeDeps(repoName, repo, events);
    const result = await createTree(deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.tree.state).toBe("on-deck");
    expect(result.tree.branch).toBe(`on-deck/${result.tree.name}`);
    expect(result.tree.readyStamp).toBe(expectedSha);

    const registry = loadRegistry(repoName);
    expect(registry.length).toBe(1);
    expect(registry[0]!.state).toBe("on-deck");
    expect(registry[0]!.name).toBe(result.tree.name);

    const worktrees = (await listWorktreesAsync(repo))!;
    const entry = worktrees.find((w) => w.path === result.tree.path);
    expect(entry).toBeDefined();
    expect(entry!.branch).toBe(`on-deck/${result.tree.name}`);

    expect(events.some((e) => e.type === "worktree:created")).toBe(true);
  });

  test("in-repo default root writes .git/info/exclude", async () => {
    const deps = makeDeps(repoName, repo, events);
    const result = await createTree(deps);

    expect(result.ok).toBe(true);
    const excludePath = join(repo, ".git", "info", "exclude");
    expect(existsSync(excludePath)).toBe(true);
    const content = readFileSync(excludePath, "utf8");
    expect(content).toContain(".worktrees/");
  });

  test("failing ready step scraps the worktree, branch, and registry entry", async () => {
    writeJson(join(repoDataDir(repoName), "config.json"), {
      worktrees: {
        namePool: ["failtree"],
        ready: [{ run: "exit 1" }],
      },
    });

    const deps = makeDeps(repoName, repo, events);
    const result = await createTree(deps);

    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "create-failed") throw new Error("expected create-failed");
    expect(result.error).toBe("create-failed");
    expect(result.failedStep).toBe("exit 1");

    const path = join(repo, ".worktrees", "failtree");
    expect(existsSync(path)).toBe(false);

    const worktrees = (await listWorktreesAsync(repo))!;
    expect(worktrees.some((w) => w.path === path)).toBe(false);

    expect(await branchExistsLocalAsync(repo, "on-deck/failtree")).toBe(false);

    const registry = loadRegistry(repoName);
    expect(registry.length).toBe(0);
  });
});

describe("scrapTree", () => {
  let repo: string;
  let repoName: string;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcreate-home-")));
    repo = makeRepo();
    addBareOrigin(repo);
    repoName = "acme";
    events = [];
  });

  test("tolerates a record whose worktree and branch never came to exist", async () => {
    const rec: TreeRecord = {
      name: "ghost",
      path: join(repo, ".worktrees", "ghost"),
      kind: "ephemeral",
      state: "creating",
      branch: "on-deck/ghost",
      createdAt: new Date().toISOString(),
    };
    saveRegistry(repoName, [rec]);

    await scrapTree(makeDeps(repoName, repo, events), rec);

    expect(loadRegistry(repoName).length).toBe(0);
  });

  test("a rename that fails with the tree still on disk keeps branch and record for retry", async () => {
    const path = join(repo, ".worktrees", "stuck");
    execSync(`git -C ${repo} worktree add -b on-deck/stuck ${path}`, { shell: "/bin/zsh", stdio: "pipe" });
    const rec: TreeRecord = {
      name: "stuck",
      path,
      kind: "ephemeral",
      state: "creating",
      branch: "on-deck/stuck",
      createdAt: new Date().toISOString(),
    };
    saveRegistry(repoName, [rec]);

    // A read-only parent makes the trash rename fail while the tree remains.
    const worktreesRoot = join(repo, ".worktrees");
    chmodSync(worktreesRoot, 0o555);
    try {
      await scrapTree(makeDeps(repoName, repo, events), rec);
    } finally {
      chmodSync(worktreesRoot, 0o755);
    }

    expect(existsSync(path)).toBe(true);
    expect(loadRegistry(repoName)).toEqual([rec]);
    const branches = execSync(`git -C ${repo} branch --list on-deck/stuck`, { shell: "/bin/zsh" }).toString();
    expect(branches).toContain("on-deck/stuck");
  });

  test("scraps a tree git itself would refuse to remove", async () => {
    // A locked worktree makes `git worktree remove --force` refuse (it wants
    // --force twice). A rename does not care: a mid-create scrap must always
    // get the half-built tree out of the way, whatever state git is in.
    const path = join(repo, ".worktrees", "locked");
    execSync(`git -C ${repo} worktree add -b on-deck/locked ${path}`, { shell: "/bin/zsh", stdio: "pipe" });
    execSync(`git -C ${repo} worktree lock ${path}`, { shell: "/bin/zsh", stdio: "pipe" });
    const rec: TreeRecord = {
      name: "locked",
      path,
      kind: "ephemeral",
      state: "creating",
      branch: "on-deck/locked",
      createdAt: new Date().toISOString(),
    };
    saveRegistry(repoName, [rec]);

    await scrapTree(makeDeps(repoName, repo, events), rec);

    expect(existsSync(path)).toBe(false);
    expect(loadRegistry(repoName).length).toBe(0);
  });
});
