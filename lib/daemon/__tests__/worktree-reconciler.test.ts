import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { writeJson } from "../../json-store.ts";
import { repoDataDir } from "../../rt-paths.ts";
import { findByPath, loadRegistry, saveRegistry, type TreeRecord } from "../../worktree/registry.ts";
import { branchExistsLocalAsync, listWorktreesAsync } from "../../worktree/git-async.ts";
import { createTree } from "../../worktree/create.ts";
import { reconcileRepoRegistry, createWorktreeReconciler } from "../worktree-reconciler.ts";

function makeRepo(): string {
  // realpathSync: git canonicalizes /var -> /private/var on macOS (Global Constraints)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-")));
  execSync(
    "git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: dir, shell: "/bin/zsh" }
  );
  return dir;
}

/** Bare-clone `repo` as its own "origin" and fetch, so remoteDefaultRef resolves origin/main. */
function addBareOrigin(repo: string): void {
  const bare = mkdtempSync(join(tmpdir(), "rtrecon-bare-"));
  execSync(
    `git clone --bare ${repo} ${bare}/o.git && git -C ${repo} remote add origin ${bare}/o.git && git -C ${repo} fetch origin`,
    { shell: "/bin/zsh" }
  );
}

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function makeDeps(repoName: string, repoPath: string, events: Array<{ type: string; data: unknown }>) {
  return {
    repoName,
    repoPath,
    emit: (type: string, data: unknown) => events.push({ type, data }),
    log: fakeLog(),
  };
}

describe("reconcileRepoRegistry", () => {
  let repo: string;
  let repoName: string;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-home-")));
    repo = makeRepo();
    repoName = "acme";
    events = [];
  });

  test("adopts main and a manually-added worktree as unmanaged", async () => {
    const manualPath = join(repo, ".worktrees", "manual");
    execSync(`git worktree add -b manual-branch ${manualPath}`, { cwd: repo, shell: "/bin/zsh" });

    const trees = await reconcileRepoRegistry(makeDeps(repoName, repo, events));

    const main = findByPath(trees, repo);
    expect(main).toBeDefined();
    expect(main!.kind).toBe("main");

    const manual = findByPath(trees, manualPath);
    expect(manual).toBeDefined();
    expect(manual!.kind).toBe("unmanaged");
    expect(manual!.branch).toBe("manual-branch");

    const registry = loadRegistry(repoName);
    expect(registry.length).toBe(2);
  });

  test("rm -rf'd manual tree is pruned, and prune lets the name be reused by createTree", async () => {
    addBareOrigin(repo);
    const name = "reuseme";
    const manualPath = join(repo, ".worktrees", name);
    execSync(`git worktree add -b manual-branch ${manualPath}`, { cwd: repo, shell: "/bin/zsh" });

    await reconcileRepoRegistry(makeDeps(repoName, repo, events));
    expect(findByPath(loadRegistry(repoName), manualPath)).toBeDefined();

    // Simulate an external `rm -rf` of the worktree dir, leaving git's own
    // registration (and the registry entry) stale.
    rmSync(manualPath, { recursive: true, force: true });

    const trees = await reconcileRepoRegistry(makeDeps(repoName, repo, events));
    expect(findByPath(trees, manualPath)).toBeUndefined();
    expect(findByPath(loadRegistry(repoName), manualPath)).toBeUndefined();

    // Reusing the same name must succeed now that `git worktree prune` ran;
    // without it git still holds the stale worktree registration at manualPath.
    writeJson(join(repoDataDir(repoName), "config.json"), {
      worktrees: { namePool: [name] },
    });

    const result = await createTree({
      repoName,
      repoPath: repo,
      emit: (type, data) => events.push({ type, data }),
      log: { info: () => {}, warn: () => {} },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.name).toBe(name);
    expect(result.tree.path).toBe(manualPath);
  });

  test("branch rename updates the registry's ground-truth branch field", async () => {
    const manualPath = join(repo, ".worktrees", "renametree");
    execSync(`git worktree add -b old-name ${manualPath}`, { cwd: repo, shell: "/bin/zsh" });

    await reconcileRepoRegistry(makeDeps(repoName, repo, events));
    expect(findByPath(loadRegistry(repoName), manualPath)!.branch).toBe("old-name");

    execSync("git branch -m old-name new-name", { cwd: manualPath, shell: "/bin/zsh" });

    const trees = await reconcileRepoRegistry(makeDeps(repoName, repo, events));
    const rec = findByPath(trees, manualPath);
    expect(rec).toBeDefined();
    expect(rec!.branch).toBe("new-name");
    expect(rec!.kind).toBe("unmanaged"); // kind/state/owner untouched by ground-truth sync
  });

  test("orphaned creating entry with no held lock is scrapped", async () => {
    const ghostPath = join(repo, ".worktrees", "ghost");
    execSync(`git worktree add -b on-deck/ghost ${ghostPath}`, { cwd: repo, shell: "/bin/zsh" });

    const ghost: TreeRecord = {
      name: "ghost",
      path: ghostPath,
      kind: "ephemeral",
      state: "creating",
      branch: "on-deck/ghost",
      createdAt: new Date().toISOString(),
    };
    saveRegistry(repoName, [ghost]);

    const trees = await reconcileRepoRegistry(makeDeps(repoName, repo, events));

    expect(findByPath(trees, ghostPath)).toBeUndefined();
    expect(existsSync(ghostPath)).toBe(false);
    expect(await branchExistsLocalAsync(repo, "on-deck/ghost")).toBe(false);

    const worktrees = await listWorktreesAsync(repo);
    expect(worktrees.some((w) => w.path === ghostPath)).toBe(false);
  });
});

describe("createWorktreeReconciler", () => {
  let repo: string;
  let repoName: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-home-")));
    repo = makeRepo();
    repoName = "acme";
  });

  test("runOnce reconciles only repos with registry entries or a worktrees config", async () => {
    const manualPath = join(repo, ".worktrees", "manual");
    execSync(`git worktree add -b manual-branch ${manualPath}`, { cwd: repo, shell: "/bin/zsh" });
    // Opt this repo into worktree management so runOnce picks it up even
    // though its registry starts empty.
    writeJson(join(repoDataDir(repoName), "config.json"), { worktrees: {} });

    const untouchedRepo = makeRepo();

    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repo, untouched: untouchedRepo }),
      emit: () => {},
      log: fakeLog(),
    });

    await reconciler.runOnce();

    expect(loadRegistry(repoName).length).toBe(2); // main + manual adopted
    expect(loadRegistry("untouched").length).toBe(0); // never touched: no config, no entries
  });

  test("kick fires runOnce without awaiting and coalesces overlapping calls", async () => {
    writeJson(join(repoDataDir(repoName), "config.json"), { worktrees: {} });

    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repo }),
      emit: () => {},
      log: fakeLog(),
    });

    reconciler.kick();
    reconciler.kick(); // should be a no-op overlap guard, not a second pass

    // kick is fire-and-forget; give the microtask queue a turn to let it land.
    await new Promise((r) => setTimeout(r, 50));

    expect(loadRegistry(repoName).length).toBe(1); // just main, adopted once
  });
});
