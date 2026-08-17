import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { Logger } from "pino";
import { readJson, writeJson } from "../../json-store.ts";
import { repoDataDir, rtDir } from "../../rt-paths.ts";
import { findByPath, loadRegistry, saveRegistry, type TreeRecord } from "../../worktree/registry.ts";
import {
  branchExistsLocalAsync,
  currentBranchAsync,
  findDesktopStashAsync,
  listWorktreesAsync,
} from "../../worktree/git-async.ts";
import { createTree } from "../../worktree/create.ts";
import { reconcileRepoRegistry, createWorktreeReconciler, __test__ } from "../worktree-reconciler.ts";

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

// ─── Merge reactor ───────────────────────────────────────────────────────────

const GIT_ID = "-c user.email=t@t -c user.name=t";

function sh(cmd: string, cwd?: string): void {
  execSync(cmd, { cwd, shell: "/bin/zsh", stdio: "pipe" });
}

describe("merge reactor (detectTransitions)", () => {
  const repoName = "acme";
  let repo: string;
  let events: Array<{ type: string; data: any }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtreact-home-")));
    repo = makeRepo();
    addBareOrigin(repo);
    // killProcesses off: the reactor must not go scanning this machine's
    // process table during a unit test.
    writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
    events = [];
  });

  function detect(entries: Record<string, unknown>, log: Logger = fakeLog()): Promise<void> {
    return __test__.detectTransitions({
      repoName,
      repoPath: repo,
      cacheEntries: entries as any,
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log,
    });
  }

  /** A logger that keeps its warnings, for the "give up, don't spin" paths. */
  function capturingLog(): { log: Logger; warns: string[] } {
    const warns: string[] = [];
    return {
      warns,
      log: {
        info: () => {},
        error: () => {},
        debug: () => {},
        warn: (_fields: unknown, msg?: string) => warns.push(msg ?? ""),
      } as unknown as Logger,
    };
  }

  function mrCache(branch: string, state: string, iid = 42): Record<string, unknown> {
    return { [branch]: { repoName, mr: { iid, state }, fetchedAt: Date.now() } };
  }

  function reactorState(): { mrState: Record<string, string | null>; fired: string[] } {
    return readJson(__test__.reactorStatePath(), { mrState: {}, fired: [] });
  }

  function tracked(path: string): TreeRecord | undefined {
    return loadRegistry(repoName).find((t) => t.path === path);
  }

  /** Ephemeral worktree on a pushed feature branch, registered as claimed. */
  function ephemeralTree(name: string, branch: string, extra: Partial<TreeRecord> = {}): TreeRecord {
    const path = join(repo, ".worktrees", name);
    sh(`git -C ${repo} worktree add -b ${branch} ${path} origin/main`);
    writeFileSync(join(path, `${name}.txt`), "work\n");
    sh(`git add -A && git ${GIT_ID} commit -m work`, path);
    sh(`git push -q origin ${branch}`, path);

    const old = new Date(Date.now() - 3600_000).toISOString();
    const rec: TreeRecord = {
      name,
      path,
      kind: "ephemeral",
      state: "claimed",
      branch,
      disposal: "merge",
      createdAt: old,
      claimedAt: old, // outside dispose's 10-minute stale-event grace
      ...extra,
    };
    saveRegistry(repoName, [...loadRegistry(repoName), rec]);
    return rec;
  }

  /** Put the main clone itself on a pushed feature branch, registered as main. */
  function mainOnBranch(branch: string): void {
    sh(`git ${GIT_ID} checkout -q -b ${branch} origin/main`, repo);
    writeFileSync(join(repo, "feature.txt"), "main work\n");
    sh(`git add -A && git ${GIT_ID} commit -m mainwork`, repo);
    sh(`git push -q origin ${branch}`, repo);
    saveRegistry(repoName, [
      { name: basename(repo), path: repo, kind: "main", branch, createdAt: new Date().toISOString() },
    ]);
  }

  test("cold boot on an already-merged cache entry deletes nothing", async () => {
    const rec = ephemeralTree("cold", "feat-cold");

    // FIRST call ever against an empty state file: the daemon has no "opened"
    // snapshot to compare against, so there is no edge and nothing may happen.
    await detect(mrCache("feat-cold", "merged"));

    expect(existsSync(rec.path)).toBe(true);
    expect(tracked(rec.path)!.state).toBe("claimed");
    expect(tracked(rec.path)!.disposableReason).toBeUndefined();
    expect(events.length).toBe(0);
    expect(reactorState().fired).toEqual([]);
    // The snapshot still records what it saw, so a later reopen→merge fires.
    expect(reactorState().mrState[`${repoName}:feat-cold`]).toBe("merged");
  });

  test("merged MR on a clean claimed tree disposes it, emits, and records a fired key", async () => {
    const rec = ephemeralTree("alpha", "feat-alpha");

    await detect(mrCache("feat-alpha", "opened"));
    expect(reactorState().mrState[`${repoName}:feat-alpha`]).toBe("opened");

    await detect(mrCache("feat-alpha", "merged"));

    expect(existsSync(rec.path)).toBe(false);
    expect(tracked(rec.path)).toBeUndefined();
    expect(events.filter((e) => e.type === "worktree:disposed").length).toBe(1);
    expect(reactorState().fired).toContain(`disposed:${repoName}:42:merged`);
  });

  test("a dirty tree flips to disposable once and never re-notifies", async () => {
    const rec = ephemeralTree("bravo", "feat-bravo");
    writeFileSync(join(rec.path, "scratch.txt"), "uncommitted\n");

    await detect(mrCache("feat-bravo", "opened"));
    await detect(mrCache("feat-bravo", "merged"));

    expect(existsSync(rec.path)).toBe(true);
    expect(tracked(rec.path)!.state).toBe("disposable");
    expect(tracked(rec.path)!.disposableReason).toBe("dirty");
    expect(events.filter((e) => e.type === "worktree:disposable").length).toBe(1);

    await detect(mrCache("feat-bravo", "merged"));
    expect(events.filter((e) => e.type === "worktree:disposable").length).toBe(1);
  });

  test("a closed MR flips the tree disposable and leaves the branch intact", async () => {
    const rec = ephemeralTree("charlie", "feat-charlie");

    await detect(mrCache("feat-charlie", "opened"));
    await detect(mrCache("feat-charlie", "closed"));

    expect(existsSync(rec.path)).toBe(true);
    expect(tracked(rec.path)!.state).toBe("disposable");
    expect(tracked(rec.path)!.disposableReason).toBe("MR closed without merge");
    expect(await branchExistsLocalAsync(repo, "feat-charlie")).toBe(true);
    expect(reactorState().fired).toContain(`disposed:${repoName}:42:closed`);
  });

  test("reopening claims the tree back and prunes its fired keys; a later merge disposes", async () => {
    const rec = ephemeralTree("delta", "feat-delta");
    const dirt = join(rec.path, "scratch.txt");
    writeFileSync(dirt, "uncommitted\n");

    await detect(mrCache("feat-delta", "opened"));
    await detect(mrCache("feat-delta", "merged"));
    expect(tracked(rec.path)!.state).toBe("disposable");
    expect(reactorState().fired).toContain(`disposed:${repoName}:42:merged`);

    await detect(mrCache("feat-delta", "opened"));
    expect(tracked(rec.path)!.state).toBe("claimed");
    expect(tracked(rec.path)!.disposableReason).toBeUndefined();
    expect(reactorState().fired).not.toContain(`disposed:${repoName}:42:merged`);

    rmSync(dirt);
    await detect(mrCache("feat-delta", "merged"));
    expect(existsSync(rec.path)).toBe(false);
    expect(tracked(rec.path)).toBeUndefined();
  });

  test("main holding the merged branch auto-returns to default, stashing and leaving the dirt", async () => {
    mainOnBranch("feat-main");
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");

    await detect(mrCache("feat-main", "opened"));
    await detect(mrCache("feat-main", "merged"));

    expect(await currentBranchAsync(repo)).toBe("main");
    const stash = await findDesktopStashAsync(repo, "feat-main");
    expect(stash).not.toBeNull();
    // stash-and-LEAVE: the dirt belonged to the branch that left, so it is
    // never popped back onto the default branch.
    expect(existsSync(join(repo, "dirty.txt"))).toBe(false);
  });

  test("a failed auto-return holds the edge armed and fires again once the repo is repaired", async () => {
    mainOnBranch("feat-lock");
    const lock = join(repo, ".git", "index.lock");

    await detect(mrCache("feat-lock", "opened"));
    writeFileSync(lock, "");
    await detect(mrCache("feat-lock", "merged"));

    expect(await currentBranchAsync(repo)).toBe("feat-lock");
    // The snapshot must NOT advance to "merged", or the edge never re-arms.
    expect(reactorState().mrState[`${repoName}:feat-lock`]).toBe("opened");
    expect(reactorState().fired).not.toContain(`disposed:${repoName}:42:merged`);

    rmSync(lock);
    await detect(mrCache("feat-lock", "merged"));

    expect(await currentBranchAsync(repo)).toBe("main");
    expect(reactorState().mrState[`${repoName}:feat-lock`]).toBe("merged");
  });

  test("a failed worktree removal is retried, never advertised as disposable", async () => {
    const rec = ephemeralTree("hotel", "feat-hotel");
    // A locked worktree makes `git worktree remove --force` refuse (it wants
    // --force twice) without touching the directory: a mechanical, transient
    // removal failure, which must NOT be reported to the user as "disposable".
    sh(`git -C ${repo} worktree lock ${rec.path}`);

    await detect(mrCache("feat-hotel", "opened"));
    await detect(mrCache("feat-hotel", "merged"));

    expect(existsSync(rec.path)).toBe(true);
    expect(tracked(rec.path)!.state).toBe("claimed");
    expect(tracked(rec.path)!.disposableReason).toBeUndefined();
    expect(events.some((e) => e.type === "worktree:disposable")).toBe(false);
    expect(reactorState().mrState[`${repoName}:feat-hotel`]).toBe("opened");

    sh(`git -C ${repo} worktree unlock ${rec.path}`);
    await detect(mrCache("feat-hotel", "merged"));

    expect(existsSync(rec.path)).toBe(false);
    expect(tracked(rec.path)).toBeUndefined();
  });

  test("auto-return gives up (does not spin) when another worktree holds the default branch", async () => {
    mainOnBranch("feat-elsewhere");
    // A second worktree parks on main, so `git checkout main` in the main
    // clone can never succeed — a configuration, not a transient.
    sh(`git -C ${repo} worktree add ${join(repo, ".worktrees", "holder")} main`);
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");

    await detect(mrCache("feat-elsewhere", "opened"));
    const { log, warns } = capturingLog();
    await detect(mrCache("feat-elsewhere", "merged"), log);

    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("main is checked out at");
    expect(await currentBranchAsync(repo)).toBe("feat-elsewhere");
    // The dirt is untouched: nothing may be stashed for a return that cannot happen.
    expect(existsSync(join(repo, "dirty.txt"))).toBe(true);
    expect(await findDesktopStashAsync(repo, "feat-elsewhere")).toBeNull();
    // Edge is spent, not re-armed — an unfixable config must not retry forever.
    expect(reactorState().mrState[`${repoName}:feat-elsewhere`]).toBe("merged");
  });

  test("auto-return gives up (does not spin) when the default branch cannot be resolved", async () => {
    // A repo whose default is "develop": remoteDefaultRef falls back to an
    // unverified "origin/master", so the checkout could never succeed.
    const odd = realpathSync(mkdtempSync(join(tmpdir(), "rtreact-odd-")));
    sh(`git init -q -b develop ${odd}`);
    sh(`git ${GIT_ID} commit -q --allow-empty -m init`, odd);
    const bare = join(realpathSync(mkdtempSync(join(tmpdir(), "rtreact-oddbare-"))), "o.git");
    sh(`git clone -q --bare ${odd} ${bare} && git -C ${odd} remote add origin ${bare} && git -C ${odd} fetch -q origin`);
    sh(`git ${GIT_ID} checkout -q -b feat-odd origin/develop`, odd);
    writeFileSync(join(odd, "dirty.txt"), "uncommitted\n");
    saveRegistry(repoName, [
      { name: "odd", path: odd, kind: "main", branch: "feat-odd", createdAt: new Date().toISOString() },
    ]);

    const pass = (state: string, log: Logger) =>
      __test__.detectTransitions({
        repoName,
        repoPath: odd,
        cacheEntries: { "feat-odd": { repoName, mr: { iid: 42, state } } } as any,
        emit: (type: string, data: unknown) => events.push({ type, data }),
        log,
      });

    await pass("opened", fakeLog());
    const { log, warns } = capturingLog();
    await pass("merged", log);

    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("neither master nor origin/master exists");
    expect(await currentBranchAsync(odd)).toBe("feat-odd");
    expect(existsSync(join(odd, "dirty.txt"))).toBe(true);
    expect(reactorState().mrState[`${repoName}:feat-odd`]).toBe("merged");
  });

  test("a successful auto-return leaves main's registry branch on the default", async () => {
    mainOnBranch("feat-ground");

    await detect(mrCache("feat-ground", "opened"));
    await detect(mrCache("feat-ground", "merged"));

    expect(tracked(repo)!.branch).toBe("main");
  });

  test("another repo's snapshot and fired keys survive a single-repo pass", async () => {
    writeJson(__test__.reactorStatePath(), {
      mrState: { "otherrepo:feat-theirs": "opened" },
      fired: ["disposed:otherrepo:9:merged"],
    });
    ephemeralTree("india", "feat-india");

    await detect(mrCache("feat-india", "opened"));

    expect(reactorState().mrState["otherrepo:feat-theirs"]).toBe("opened");
    expect(reactorState().fired).toContain("disposed:otherrepo:9:merged");
  });

  test("a cache entry with no repoName joins this repo and acts", async () => {
    const rec = ephemeralTree("juliet", "feat-juliet");
    const unattributed = (state: string) => ({ "feat-juliet": { mr: { iid: 42, state } } });

    await detect(unattributed("opened"));
    await detect(unattributed("merged"));

    expect(existsSync(rec.path)).toBe(false);
    expect(tracked(rec.path)).toBeUndefined();
  });

  test('a disposal:"job" tree with a merged MR is untouched', async () => {
    const rec = ephemeralTree("echo", "feat-echo", { disposal: "job" });

    await detect(mrCache("feat-echo", "opened"));
    await detect(mrCache("feat-echo", "merged"));

    expect(existsSync(rec.path)).toBe(true);
    expect(tracked(rec.path)!.state).toBe("claimed");
    expect(tracked(rec.path)!.disposableReason).toBeUndefined();
    expect(events.length).toBe(0);
  });

  test("cache entries belonging to another repo never join this repo's trees", async () => {
    const rec = ephemeralTree("foxtrot", "feat-foxtrot");
    const foreign = { "feat-foxtrot": { repoName: "other", mr: { iid: 42, state: "opened" } } };

    await detect(foreign);
    await detect({ "feat-foxtrot": { repoName: "other", mr: { iid: 42, state: "merged" } } });

    expect(existsSync(rec.path)).toBe(true);
    expect(tracked(rec.path)!.state).toBe("claimed");
  });

  test("runOnce runs the reactor after the reconcile pass", async () => {
    const rec = ephemeralTree("golf", "feat-golf");
    writeJson(join(repoDataDir(repoName), "config.json"), { worktrees: {} });

    const cache = { entries: mrCache("feat-golf", "opened") as Record<string, any> };
    const reconciler = createWorktreeReconciler({
      cache,
      repoIndex: () => ({ [repoName]: repo }),
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log: fakeLog(),
    });

    await reconciler.runOnce();
    cache.entries = mrCache("feat-golf", "merged") as Record<string, any>;
    await reconciler.runOnce();

    expect(existsSync(rec.path)).toBe(false);
    expect(events.some((e) => e.type === "worktree:disposed")).toBe(true);
  });
});
