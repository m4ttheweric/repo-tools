import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import type { Logger } from "pino";
import { readJson, writeJson } from "../../json-store.ts";
import { closeStateDb, listKvValues, setKvValue } from "../../state/index.ts";
import { machineSettingsPath, rtDir, teamSettingsPath } from "../../rt-paths.ts";
import { deriveRepoIdentity, parseIdentity } from "../../settings/identity.ts";
import { findByPath, loadRegistry, saveRegistry, type TreeRecord } from "../../worktree/registry.ts";
import {
  branchExistsLocalAsync,
  currentBranchAsync,
  findDesktopStashAsync,
  headSha,
  listWorktreesAsync,
} from "../../worktree/git-async.ts";
import { createTree } from "../../worktree/create.ts";
import type { WorktreeAppConfig } from "../../worktree/config.ts";
import { RETENTION_MS } from "../../worktree/trash.ts";
import { reconcileRepoRegistry, createWorktreeReconciler, withCreateLock, __test__ } from "../worktree-reconciler.ts";

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

function readMachineStore(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(machineSettingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeMachineStore(obj: Record<string, unknown>): void {
  mkdirSync(join(machineSettingsPath(), ".."), { recursive: true });
  writeFileSync(machineSettingsPath(), JSON.stringify(obj));
}

/**
 * Gives `repoPath` a resolvable settings identity: reuses its origin if it
 * has one (adding a throwaway one if not) and, when the origin doesn't
 * itself normalize (this file's bare-clone fixtures are local filesystem
 * paths), pins it via the machine store's `rt.repoIdentityOverrides` —
 * exactly the fork/local-remote mechanism production uses.
 */
async function ensureIdentity(repoPath: string, repoName: string): Promise<string> {
  let remote: string | null = null;
  try {
    remote = execSync("git config --get remote.origin.url", { cwd: repoPath, encoding: "utf8" }).trim() || null;
  } catch { /* no origin configured yet */ }
  if (!remote) {
    remote = `git@rttest:${repoName}.git`;
    execSync(`git remote add origin ${remote}`, { cwd: repoPath, shell: "/bin/zsh" });
  }

  const direct = await deriveRepoIdentity(repoPath);
  if (direct.kind === "remote") return direct.id;

  const identity = `rttest.local/${repoName}`;
  const store = readMachineStore();
  const overrides = { ...(store["rt.repoIdentityOverrides"] as Record<string, string> ?? {}), [remote]: identity };
  writeMachineStore({ ...store, "rt.repoIdentityOverrides": overrides });
  return identity;
}

/** Seeds `rt.worktrees` for `repoPath` in the machine store — the store-only replacement for the old per-repo config.json fixture. */
async function declareWorktrees(repoPath: string, repoName: string, declared: unknown): Promise<void> {
  const identity = await ensureIdentity(repoPath, repoName);
  const store = readMachineStore();
  const repos = { ...(store.repos as Record<string, unknown> ?? {}), [identity]: { "rt.worktrees": declared } };
  writeMachineStore({ ...store, repos });
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

/**
 * A repo whose worktree registry is still keyed by a pre-identity legacy
 * name — the shape a machine upgrading onto identity keys carries.
 * The origin remote is derived from `identity` itself (via a plain
 * `host/path` URL) so `deriveRepoIdentity` resolves back to exactly that
 * identity, matching the reconciler's own `repoIndex()` key.
 */
async function reconcilerHarnessWithLegacyRegistry(
  legacyName: string,
  identity: string,
): Promise<{ runOnce: () => Promise<void> }> {
  const parsed = parseIdentity(identity);
  if (!parsed || parsed.kind !== "remote") throw new Error(`fixture identity must be remote-kind: ${identity}`);
  const repoPath = makeRepo();
  execSync(`git remote add origin https://${parsed.id}.git`, { cwd: repoPath, shell: "/bin/zsh" });

  setKvValue("repo-index", legacyName, repoPath);
  saveRegistry(legacyName, [
    { name: "main", path: repoPath, kind: "main", branch: "main", createdAt: new Date().toISOString() },
  ]);

  const reconciler = createWorktreeReconciler({
    cache: { entries: {} },
    repoIndex: () => ({ [identity]: repoPath }),
    emit: () => {},
    log: fakeLog(),
  });
  return { runOnce: reconciler.runOnce };
}

describe("reconcileRepoRegistry", () => {
  let repo: string;
  let repoName: string;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-home-")));
    closeStateDb();
    __test__.createBackoff.clear();
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
    await declareWorktrees(repo, repoName, { namePool: [name] });

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

    const worktrees = (await listWorktreesAsync(repo))!;
    expect(worktrees.some((w) => w.path === ghostPath)).toBe(false);
  });

  test("a broken git dir leaves an existing registry row untouched instead of pruning it", async () => {
    // Adopt the main clone into the registry on a healthy pass first.
    await reconcileRepoRegistry(makeDeps(repoName, repo, events));
    const before = loadRegistry(repoName);
    expect(before.length).toBe(1);
    expect(before[0]!.kind).toBe("main");

    // Break the git dir so `git worktree list --porcelain` fails.
    rmSync(join(repo, ".git"), { recursive: true, force: true });

    const trees = await reconcileRepoRegistry(makeDeps(repoName, repo, events));

    expect(trees).toEqual(before);
    expect(loadRegistry(repoName)).toEqual(before);
  });

  /**
   * The concurrency contract: reconcile loads a whole-registry snapshot and
   * then awaits git for a long time, so every other writer (provision's claim,
   * dispose's prune, freshen's patch) runs on the same event loop inside that
   * window. `onAfterLoad` is the deterministic stand-in for that writer — it
   * fires right after reconcile captures its snapshot and epoch.
   */
  function claimConcurrently(path: string, owner: string): void {
    const cur = loadRegistry(repoName);
    const rec = cur.find((t) => t.path === path);
    if (!rec) throw new Error(`no registry row at ${path}`);
    rec.state = "claimed";
    rec.owner = owner;
    rec.claimedAt = new Date().toISOString();
    saveRegistry(repoName, cur);
  }

  function onDeckRow(path: string): TreeRecord {
    return {
      name: basename(path),
      path,
      kind: "ephemeral",
      state: "on-deck",
      branch: `on-deck/${basename(path)}`,
      createdAt: new Date().toISOString(),
    };
  }

  test("a claim landing mid-pass survives; reconcile retries instead of saving its stale snapshot", async () => {
    const treePath = join(repo, ".worktrees", "claimable");
    execSync(`git worktree add -b on-deck/claimable ${treePath}`, { cwd: repo, shell: "/bin/zsh" });
    // Only the ephemeral tree is registered, so reconcile's own correction this
    // pass is adopting the main clone (changed -> a whole-snapshot save).
    saveRegistry(repoName, [onDeckRow(treePath)]);

    let fired = false;
    const trees = await reconcileRepoRegistry({
      ...makeDeps(repoName, repo, events),
      onAfterLoad: () => {
        if (fired) return;
        fired = true;
        claimConcurrently(treePath, "matt");
      },
    });

    const final = loadRegistry(repoName);
    const claim = findByPath(final, treePath);
    expect(claim).toBeDefined();
    expect(claim!.state).toBe("claimed"); // NOT reverted to on-deck
    expect(claim!.owner).toBe("matt");

    // ...and reconcile's own correction still landed, on the retry pass.
    expect(findByPath(final, repo)?.kind).toBe("main");
    expect(findByPath(trees, repo)?.kind).toBe("main");
    expect(findByPath(trees, treePath)?.state).toBe("claimed");
  });

  test("a writer landing on every attempt exhausts the retries: reconcile warns and skips its save", async () => {
    const treePath = join(repo, ".worktrees", "contended");
    execSync(`git worktree add -b on-deck/contended ${treePath}`, { cwd: repo, shell: "/bin/zsh" });
    saveRegistry(repoName, [onDeckRow(treePath)]);

    const warns: unknown[][] = [];
    let attempts = 0;
    const log = {
      info: () => {},
      warn: (...args: unknown[]) => warns.push(args),
      error: () => {},
      debug: () => {},
    } as unknown as Logger;

    const trees = await reconcileRepoRegistry({
      repoName,
      repoPath: repo,
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log,
      onAfterLoad: () => {
        attempts++;
        claimConcurrently(treePath, `w${attempts}`);
      },
    });

    expect(attempts).toBe(3); // bounded: three attempts, then give up
    expect(warns.length).toBe(1);

    const final = loadRegistry(repoName);
    // The last competing write stands; reconcile's adoption of main is dropped
    // rather than written over it. The next pass picks it up again.
    expect(findByPath(final, treePath)!.owner).toBe("w3");
    expect(findByPath(final, repo)).toBeUndefined();
    expect(findByPath(trees, treePath)!.owner).toBe("w3");
  });
});

describe("createWorktreeReconciler", () => {
  let repo: string;
  let repoName: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-home-")));
    closeStateDb();
    __test__.createBackoff.clear();
    repo = makeRepo();
    repoName = "acme";
  });

  test("runOnce reconciles only repos with registry entries or a worktrees config", async () => {
    const manualPath = join(repo, ".worktrees", "manual");
    execSync(`git worktree add -b manual-branch ${manualPath}`, { cwd: repo, shell: "/bin/zsh" });
    // Opt this repo into worktree management so runOnce picks it up even
    // though its registry starts empty.
    await declareWorktrees(repo, repoName, {});

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

  test("runOnce reconciles a repo whose worktrees declaration lives ONLY in a settings store", async () => {
    // RT-47: the opt-in signal used to be `worktrees` in the per-repo
    // config.json. A repo migrated to the stores has no such file at all, and
    // must still be reconciled — the gate now asks the resolver.
    const identity = "gitlab.com/acme/store-gated";
    execSync(`git remote add origin git@gitlab.com:acme/store-gated.git`, {
      cwd: repo,
      shell: "/bin/zsh",
    });
    const manualPath = join(repo, ".worktrees", "manual");
    execSync(`git worktree add -b manual-branch ${manualPath}`, { cwd: repo, shell: "/bin/zsh" });

    const teamStore = teamSettingsPath("acme");
    mkdirSync(join(teamStore, ".."), { recursive: true });
    writeFileSync(
      teamStore,
      JSON.stringify({ repos: { [identity]: { "rt.worktrees": { namePool: ["luna"] } } } }),
    );

    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repo }),
      emit: () => {},
      log: fakeLog(),
    });

    await reconciler.runOnce();

    expect(loadRegistry(repoName).length).toBe(2); // main + manual adopted
  });

  test("kick fires runOnce without awaiting and coalesces overlapping calls", async () => {
    await declareWorktrees(repo, repoName, {});

    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repo }),
      emit: () => {},
      log: fakeLog(),
    });

    reconciler.kick();
    reconciler.kick(); // should be a no-op overlap guard, not a second pass

    // kick is fire-and-forget; poll `passInFlight()` for TRUE completion
    // rather than a blind sleep or a registry-state proxy — a pass that's
    // still running (even past its registry write) but hasn't returned yet
    // would otherwise dangle past this test, and since every internal path
    // (machineSettingsPath, rtDir, ...) resolves HOME dynamically at call time, that
    // stale pass can read/write into a LATER test's HOME once that test's
    // beforeEach repoints the (shared, global) env var.
    await waitFor(() => !reconciler.passInFlight(), 5000);

    expect(loadRegistry(repoName).length).toBe(1); // just main, adopted once
  });

  test("runOnce reaps .trash-* leftovers in the default and configured roots", async () => {
    // What a daemon crash mid-reap leaves behind: the dispose renamed the tree
    // but its detached `rm -rf` never finished (or never started).
    const configuredRoot = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-root-")));
    await declareWorktrees(repo, repoName, { root: configuredRoot });

    const defaultRootTrash = join(repo, ".worktrees", ".trash-hotel-1700000000000");
    const configuredTrash = join(configuredRoot, ".trash-india-1700000000001");
    const live = join(configuredRoot, "juliet");
    for (const dir of [defaultRootTrash, configuredTrash, live]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "file.txt"), "x\n");
    }

    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repo }),
      emit: () => {},
      log: fakeLog(),
    });

    await reconciler.runOnce();

    expect(existsSync(defaultRootTrash)).toBe(false);
    expect(existsSync(configuredTrash)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("runOnce with the app disabled still syncs the registry, but skips reactor/freshen/replenish", async () => {
    // A dedicated repoName (not the shared "acme" the other tests in this
    // describe use): the prior test's `kick()` is deliberately unawaited by
    // design, and since every internal path resolves HOME dynamically at call
    // time, a still-running background pass from that test reading a fresh
    // `worktrees.json`/onDeck config off "acme" could otherwise land its own
    // (stale, enabled=true-baked-in) replenish attempt into this test's
    // registry. A distinct repoName makes that collision structurally
    // impossible regardless of any other test's timing.
    const disabledRepoName = "acme-disabled";
    addBareOrigin(repo);
    await declareWorktrees(repo, disabledRepoName, { onDeck: 1, root: join(repo, ".worktrees") });
    writeJson(join(rtDir(), "worktrees.json"), { enabled: false, killProcesses: false });

    // Advance origin so a freshen (if it ran) would have something to do.
    const originUrl = execSync(`git -C ${repo} remote get-url origin`, { encoding: "utf8" }).trim();
    const clone = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-clone-")));
    sh(`git clone -q ${originUrl} ${clone}`);
    writeFileSync(join(clone, "feature.txt"), "hi\n");
    sh(`git add -A && git ${GIT_ID} commit -m feat`, clone);
    sh(`git push -q origin main`, clone);

    const seededTrash = join(repo, ".worktrees", ".trash-kilo-1700000000002");
    mkdirSync(seededTrash, { recursive: true });

    const beforeSha = await headSha(repo);
    const events: Array<{ type: string; data: any }> = [];
    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [disabledRepoName]: repo }),
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log: fakeLog(),
    });

    await reconciler.runOnce();

    // Read-only reconcile still ran: main got adopted into the registry.
    const trees = loadRegistry(disabledRepoName);
    expect(trees.some((t) => t.path === repo && t.kind === "main")).toBe(true);

    // Freshen skipped: main never fetched/ff'd despite being idle and behind.
    expect(await headSha(repo)).toBe(beforeSha);
    // Replenish skipped: no on-deck tree created despite onDeck:1.
    expect(trees.some((t) => t.kind === "ephemeral")).toBe(false);
    // Reactor skipped: it never even opened/wrote its state.
    expect(__test__.hasReactorState()).toBe(false);
    expect(events.length).toBe(0);
    // Reap skipped: it deletes directories, so it is gated like every other
    // mutating duty.
    expect(existsSync(seededTrash)).toBe(true);
  });

  test("a legacy name-keyed registry is re-keyed onto the repo's identity on first reconcile", async () => {
    const h = await reconcilerHarnessWithLegacyRegistry("repo-tools", "remote:gitlab.com%2Fg%2Frepo-tools");

    await h.runOnce();

    const keys = Object.keys(listKvValues("worktree-registry"));
    expect(keys).toContain("remote:gitlab.com%2Fg%2Frepo-tools");
    expect(keys).not.toContain("repo-tools");
  });
});

// ─── Reactor state persistence (RT-50 collapse) ───────────────────────────────

describe("reactor state — state.db persistence", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtreactstate-home-")));
    closeStateDb();
  });

  test("saveReactorState/loadReactorState round-trip through state.db", () => {
    expect(__test__.hasReactorState()).toBe(false);
    __test__.saveReactorState({ mrState: { "acme:feat-x": "opened" }, fired: ["disposed:acme:1:merged"] }, fakeLog());
    expect(__test__.hasReactorState()).toBe(true);
    expect(__test__.loadReactorState()).toEqual({ mrState: { "acme:feat-x": "opened" }, fired: ["disposed:acme:1:merged"] });
  });

  test("a pre-existing worktree-reactor-state.json is imported on first read, and renamed to .migrated", () => {
    mkdirSync(rtDir(), { recursive: true });
    const legacyState = { mrState: { "acme:x": "opened" }, fired: ["disposed:acme:1:merged"] };
    writeFileSync(__test__.reactorStatePath(), JSON.stringify(legacyState));
    expect(existsSync(__test__.reactorStatePath())).toBe(true);

    expect(__test__.loadReactorState()).toEqual(legacyState);
    expect(existsSync(__test__.reactorStatePath())).toBe(false);
    expect(existsSync(`${__test__.reactorStatePath()}.migrated`)).toBe(true);

    __test__.saveReactorState({ mrState: { "fresh:y": "merged" }, fired: [] }, fakeLog());
    expect(__test__.loadReactorState()).toEqual({ mrState: { "fresh:y": "merged" }, fired: [] });
  });

  test("a corrupt worktree-reactor-state.json warns and is left in place; loadReactorState reads as empty", () => {
    mkdirSync(rtDir(), { recursive: true });
    writeFileSync(__test__.reactorStatePath(), "{ not valid json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(__test__.loadReactorState()).toEqual({ mrState: {}, fired: [] });
      expect(existsSync(__test__.reactorStatePath())).toBe(true);
      expect(existsSync(`${__test__.reactorStatePath()}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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
    closeStateDb();
    __test__.createBackoff.clear();
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
    return __test__.loadReactorState();
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
    // Disposal renames the tree into a sibling trash dir, so the mechanical,
    // transient failure to reproduce is a root nothing can be renamed within.
    // The tree survives untouched, and that must NOT be reported to the user
    // as "disposable".
    const root = join(repo, ".worktrees");
    chmodSync(root, 0o555);

    try {
      await detect(mrCache("feat-hotel", "opened"));
      await detect(mrCache("feat-hotel", "merged"));

      expect(existsSync(rec.path)).toBe(true);
      expect(tracked(rec.path)!.state).toBe("claimed");
      expect(tracked(rec.path)!.disposableReason).toBeUndefined();
      expect(events.some((e) => e.type === "worktree:disposable")).toBe(false);
      expect(reactorState().mrState[`${repoName}:feat-hotel`]).toBe("opened");
    } finally {
      chmodSync(root, 0o755);
    }

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
    __test__.saveReactorState({
      mrState: { "otherrepo:feat-theirs": "opened" },
      fired: ["disposed:otherrepo:9:merged"],
    }, fakeLog());
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
    await declareWorktrees(repo, repoName, {});

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

// ─── Freshen ─────────────────────────────────────────────────────────────────

/** Clone `repo`'s own bare origin to a scratch dir, for pushing "upstream" advances. */
function cloneOrigin(repo: string): string {
  const originUrl = execSync(`git -C ${repo} remote get-url origin`, { encoding: "utf8" }).trim();
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-clone-")));
  sh(`git clone -q ${originUrl} ${clone}`);
  return clone;
}

function pushFile(clone: string, relPath: string, contents: string): string {
  writeFileSync(join(clone, relPath), contents);
  sh(`git add -A && git ${GIT_ID} commit -m ${relPath}`, clone);
  sh(`git push -q origin main`, clone);
  return execSync("git rev-parse HEAD", { cwd: clone, encoding: "utf8" }).trim();
}

describe("freshen", () => {
  const repoName = "acme";
  let repo: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtfreshen-home-")));
    closeStateDb();
    __test__.createBackoff.clear();
    repo = makeRepo();
    addBareOrigin(repo);
    writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
  });

  test("idle main behind origin gets ff'd; readyStamp advances only when a triggered step ran; worktree:freshened emitted", async () => {
    await declareWorktrees(repo, repoName, {
      ready: [{ run: "touch triggered.marker", when: "changed:*.txt" }],
    });
    // Tracked and pushed so the ready step's own marker file never shows up as
    // untracked dirt on a later pass (which would otherwise flip "idle main"
    // non-idle and stall freshen on itself).
    writeFileSync(join(repo, ".gitignore"), "*.marker\n");
    sh(`git add -A && git ${GIT_ID} commit -m gitignore`, repo);
    sh(`git push -q origin main`, repo);

    saveRegistry(repoName, [
      { name: basename(repo), path: repo, kind: "main", branch: "main", createdAt: new Date().toISOString() },
    ]);

    const clone = cloneOrigin(repo);
    const sha1 = pushFile(clone, "feature.txt", "hi\n");

    const events: Array<{ type: string; data: any }> = [];
    await __test__.freshenRepo({
      repoName,
      repoPath: repo,
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log: fakeLog(),
    });

    expect(await headSha(repo)).toBe(sha1);
    expect(existsSync(join(repo, "triggered.marker"))).toBe(true);
    const rec1 = loadRegistry(repoName).find((t) => t.path === repo)!;
    expect(rec1.readyStamp).toBe(sha1);
    expect(events.some((e) => e.type === "worktree:freshened")).toBe(true);

    // Second pass: origin advances again, but with a change the glob does not
    // match. The ff still moves HEAD; readyStamp must NOT follow it, since no
    // step actually validated content as of the new commit.
    const sha2 = pushFile(clone, "notes.md", "hi\n");
    await __test__.freshenRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });

    expect(await headSha(repo)).toBe(sha2);
    const rec2 = loadRegistry(repoName).find((t) => t.path === repo)!;
    expect(rec2.readyStamp).toBe(sha1);
  });

  test("on-deck tree ff's its on-deck branch", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees") });

    const created = await createTree({
      repoName,
      repoPath: repo,
      emit: () => {},
      log: { info: () => {}, warn: () => {} },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const treePath = created.tree.path;
    const beforeSha = await headSha(treePath);

    const clone = cloneOrigin(repo);
    const sha1 = pushFile(clone, "feature.txt", "hi\n");

    await __test__.freshenRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });

    const afterSha = await headSha(treePath);
    expect(afterSha).not.toBe(beforeSha);
    expect(afterSha).toBe(sha1);
  });

  test("a failing ready step sets nextRetryAt; the next immediate pass skips the tree", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees") });

    const created = await createTree({
      repoName,
      repoPath: repo,
      emit: () => {},
      log: { info: () => {}, warn: () => {} },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const treePath = created.tree.path;

    // Reconfigure with a step that always fails once triggered.
    await declareWorktrees(repo, repoName, {
      onDeck: 1, root: join(repo, ".worktrees"), ready: [{ run: "exit 1", when: "changed:*.txt" }],
    });

    const clone = cloneOrigin(repo);
    pushFile(clone, "feature.txt", "hi\n");

    await __test__.freshenRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });

    const rec1 = loadRegistry(repoName).find((t) => t.path === treePath)!;
    expect(rec1.retryFailures).toBe(1);
    expect(rec1.nextRetryAt).toBeDefined();
    expect(Date.parse(rec1.nextRetryAt!)).toBeGreaterThan(Date.now());

    // Immediate second pass: nextRetryAt is in the future, so the tree must
    // be skipped entirely, not retried (and re-failed) again.
    await __test__.freshenRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });

    const rec2 = loadRegistry(repoName).find((t) => t.path === treePath)!;
    expect(rec2.retryFailures).toBe(1);
    expect(rec2.nextRetryAt).toBe(rec1.nextRetryAt);
  });

  test("dirty non-idle main is left untouched", async () => {
    writeFileSync(join(repo, "dirty.txt"), "uncommitted\n");
    saveRegistry(repoName, [
      { name: basename(repo), path: repo, kind: "main", branch: "main", createdAt: new Date().toISOString() },
    ]);

    const beforeSha = await headSha(repo);
    const events: Array<{ type: string; data: any }> = [];
    await __test__.freshenRepo({
      repoName,
      repoPath: repo,
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log: fakeLog(),
    });

    expect(await headSha(repo)).toBe(beforeSha);
    expect(existsSync(join(repo, "dirty.txt"))).toBe(true);
    expect(events.length).toBe(0);
    const rec = loadRegistry(repoName).find((t) => t.path === repo)!;
    expect(rec.readyAt).toBeUndefined();
  });

  test("a candidate claimed mid-pass is revalidated under the lock and skipped", async () => {
    await declareWorktrees(repo, repoName, {
      onDeck: 2, root: join(repo, ".worktrees"), ready: [{ run: "sleep 1", when: "changed:*.txt" }],
    });

    // Two on-deck trees. `freshenRepo` snapshots the whole registry once and
    // processes them in order — A first (slow: its ready step triggers below),
    // B only after A finishes. That gap is the window under test.
    const a = await createTree({ repoName, repoPath: repo, emit: () => {}, log: { info: () => {}, warn: () => {} } });
    const b = await createTree({ repoName, repoPath: repo, emit: () => {}, log: { info: () => {}, warn: () => {} } });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const pathA = a.tree.path;
    const pathB = b.tree.path;
    const bBeforeSha = await headSha(pathB);

    const clone = cloneOrigin(repo);
    const pushedSha = pushFile(clone, "feature.txt", "hi\n");

    const events: Array<{ type: string; data: any }> = [];
    const freshenPromise = __test__.freshenRepo({
      repoName,
      repoPath: repo,
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log: fakeLog(),
    });

    // Land well inside A's ~1s triggered ready step, long before the loop's
    // (already-stale, in-memory) snapshot for B is ever acted on. This proves
    // the fix, not the unmodified outer candidacy check: B's candidacy was
    // already decided (true, "on-deck") against the pre-claim snapshot before
    // this write lands on disk.
    await new Promise((r) => setTimeout(r, 300));
    saveRegistry(
      repoName,
      loadRegistry(repoName).map((t) => (t.path === pathB ? { ...t, state: "claimed" as const } : t)),
    );

    await freshenPromise;

    // A freshened normally — the fix doesn't cost the happy path.
    expect(await headSha(pathA)).toBe(pushedSha);
    expect(events.some((e) => e.type === "worktree:freshened" && e.data.path === pathA)).toBe(true);

    // B was claimed mid-pass: freshen must not have touched it.
    expect(await headSha(pathB)).toBe(bBeforeSha);
    expect(events.some((e) => e.data?.path === pathB)).toBe(false);
    expect(loadRegistry(repoName).find((t) => t.path === pathB)!.state).toBe("claimed");
  }, 10_000);
});

// ─── Replenish / shrink ───────────────────────────────────────────────────────

function fakeAppConfig(overrides: Partial<WorktreeAppConfig> = {}): WorktreeAppConfig {
  return { enabled: true, killProcesses: false, ...overrides };
}

describe("replenish / shrink", () => {
  const repoName = "acme";
  let repo: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtpool-home-")));
    closeStateDb();
    __test__.createBackoff.clear();
    repo = makeRepo();
    addBareOrigin(repo);
  });

  test("onDeck=2 with an empty registry creates 2, serially", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 2, root: join(repo, ".worktrees") });

    await __test__.replenishAndShrink(
      { repoName, repoPath: repo, emit: () => {}, log: fakeLog() },
      new Map(),
      fakeAppConfig(),
    );

    const trees = loadRegistry(repoName).filter((t) => t.kind === "ephemeral" && t.state === "on-deck");
    expect(trees.length).toBe(2);
    expect(new Set(trees.map((t) => t.name)).size).toBe(2);
  });

  test("an all-failing pool does not overshoot the onDeck cap", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 2, root: join(repo, ".worktrees"), ready: [{ run: "exit 1" }] });

    const warns: string[] = [];
    const log = {
      info: () => {},
      error: () => {},
      debug: () => {},
      warn: (_fields: unknown, msg?: string) => warns.push(msg ?? ""),
    } as unknown as Logger;

    await __test__.replenishAndShrink(
      { repoName, repoPath: repo, emit: () => {}, log },
      new Map(),
      fakeAppConfig(),
    );

    const trees = loadRegistry(repoName).filter((t) => t.kind === "ephemeral");
    expect(trees.length).toBe(0); // the attempt failed and self-scrapped

    // Bounded twice over: never more than onDeck attempts, and the first
    // failure's backoff ends the pass before the second is even tried.
    expect(warns.filter((w) => w.includes("replenish create failed")).length).toBe(1);
  });

  test("a failed create backs off, and the next pass skips replenish for that repo", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 2, root: join(repo, ".worktrees"), ready: [{ run: "exit 1" }] });

    const warns: string[] = [];
    const log = {
      info: () => {},
      error: () => {},
      debug: () => {},
      warn: (_fields: unknown, msg?: string) => warns.push(msg ?? ""),
    } as unknown as Logger;
    const deps = { repoName, repoPath: repo, emit: () => {}, log };

    await __test__.replenishAndShrink(deps, new Map(), fakeAppConfig());
    expect(warns.filter((w) => w.includes("replenish create failed")).length).toBe(1);

    const backoff = __test__.createBackoff.get(repoName);
    expect(backoff?.failures).toBe(1);
    expect(Date.parse(backoff!.nextRetryAt)).toBeGreaterThan(Date.now());

    // The very next pass (the next cache tick, seconds later) must not burn
    // another multi-minute build on the same broken step.
    await __test__.replenishAndShrink(deps, new Map(), fakeAppConfig());
    expect(warns.filter((w) => w.includes("replenish create failed")).length).toBe(1);
    expect(__test__.createBackoff.get(repoName)?.failures).toBe(1);
  });

  test("a successful create clears the backoff", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees") });
    // An expired backoff from earlier failures: the pass runs, and success wipes it.
    __test__.createBackoff.set(repoName, {
      failures: 3,
      nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
    });

    await __test__.replenishAndShrink(
      { repoName, repoPath: repo, emit: () => {}, log: fakeLog() },
      new Map(),
      fakeAppConfig(),
    );

    expect(loadRegistry(repoName).filter((t) => t.state === "on-deck").length).toBe(1);
    expect(__test__.createBackoff.has(repoName)).toBe(false);
  });

  test("backoff doubles one pass at a time and caps at 30 minutes", () => {
    expect(__test__.backoffDelayMs(1)).toBe(5 * 60_000);
    expect(__test__.backoffDelayMs(2)).toBe(10 * 60_000);
    expect(__test__.backoffDelayMs(3)).toBe(20 * 60_000);
    expect(__test__.backoffDelayMs(4)).toBe(30 * 60_000); // 40 min, capped
    expect(__test__.backoffDelayMs(12)).toBe(30 * 60_000);
  });

  test("lowering onDeck disposes the stalest ready entry", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 2, root: join(repo, ".worktrees") });

    await __test__.replenishAndShrink(
      { repoName, repoPath: repo, emit: () => {}, log: fakeLog() },
      new Map(),
      fakeAppConfig(),
    );

    let trees = loadRegistry(repoName).filter((t) => t.kind === "ephemeral" && t.state === "on-deck");
    expect(trees.length).toBe(2);

    // Force a deterministic staleness ordering rather than relying on the
    // sub-millisecond gap between two serial creates.
    const [older, newer] = trees;
    saveRegistry(
      repoName,
      loadRegistry(repoName).map((t) => {
        if (t.path === older!.path) return { ...t, readyAt: new Date(Date.now() - 60_000).toISOString() };
        if (t.path === newer!.path) return { ...t, readyAt: new Date().toISOString() };
        return t;
      }),
    );

    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees") });
    await __test__.replenishAndShrink(
      { repoName, repoPath: repo, emit: () => {}, log: fakeLog() },
      new Map(),
      fakeAppConfig(),
    );

    trees = loadRegistry(repoName).filter((t) => t.kind === "ephemeral" && t.state === "on-deck");
    expect(trees.length).toBe(1);
    expect(trees[0]!.path).toBe(newer!.path);
    expect(existsSync(older!.path)).toBe(false);
  });
});

// ─── Detached trigger / latency ───────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("detached trigger / latency", () => {
  test("kick() returns synchronously, coalesces a second kick during the pass, and creationInFlight tracks it", async () => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtkick-home-")));
    closeStateDb();
    __test__.createBackoff.clear();
    const repoName = "acme";
    const repo = makeRepo();
    addBareOrigin(repo);
    // Non-idle main (real, unrelated dirt): keeps freshen from also picking
    // up main and running its own "sleep 3" pass, which would confound the
    // timing assertions below without changing what's under test here.
    writeFileSync(join(repo, "wip.txt"), "not idle\n");

    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees"), ready: [{ run: "sleep 3" }] });

    const events: Array<{ type: string; data: any }> = [];
    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [repoName]: repo }),
      emit: (type: string, data: unknown) => events.push({ type, data }),
      log: fakeLog(),
    });

    const t0 = Date.now();
    reconciler.kick();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // kick() itself never awaits the pass

    await waitFor(() => reconciler.creationInFlight(repoName) !== null, 2000);
    expect(reconciler.creationInFlight(repoName)).not.toBeNull();

    reconciler.kick(); // overlap guard: must not start a second concurrent pass

    await waitFor(() => reconciler.creationInFlight(repoName) === null, 6000);
    expect(reconciler.creationInFlight(repoName)).toBeNull();

    expect(events.filter((e) => e.type === "worktree:created").length).toBe(1);
  }, 10_000);

  // S065: a kick() during an in-flight pass, once the pass has started
  // working (its per-repo loop has begun — this repo's replenish may
  // already have run), must not be silently dropped. Observed here via
  // repoIndex() call count: it's read fresh once per runOnce() invocation,
  // so a queued follow-up pass is externally visible as a second call.
  test("a kick() arriving after the pass has started work triggers a follow-up pass, not a silent drop (S065)", async () => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtkick2-home-")));
    closeStateDb();
    __test__.createBackoff.clear();
    const repoName = "acme-kick2";
    const repo = makeRepo();
    addBareOrigin(repo);
    writeFileSync(join(repo, "wip.txt"), "not idle\n");
    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees"), ready: [{ run: "sleep 2" }] });

    let repoIndexCalls = 0;
    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => { repoIndexCalls++; return { [repoName]: repo }; },
      emit: () => {},
      log: fakeLog(),
    });

    reconciler.kick();
    await waitFor(() => reconciler.creationInFlight(repoName) !== null, 2000);
    // Mid-pass: this repo's replenish step is already running, so this kick
    // must queue a follow-up rather than being dropped.
    reconciler.kick();

    await waitFor(() => reconciler.creationInFlight(repoName) === null, 6000);
    await waitFor(() => repoIndexCalls >= 2, 6000); // the queued follow-up pass actually ran
    expect(repoIndexCalls).toBeGreaterThanOrEqual(2);
  }, 15_000);
});

describe("reapRepoTrash", () => {
  let repo: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtrecon-home-")));
    closeStateDb();
    repo = makeRepo();
  });

  /** Poll until `cond` holds — the reap is a detached process nobody awaits. */
  async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  test("sweeps crash leftovers immediately and retained trees only past retention", async () => {
    const root = join(repo, ".worktrees");
    const leftover = join(root, ".trash-hotel-123");
    const expired = join(root, ".trash", `india-${Date.now() - RETENTION_MS - 60_000}`);
    const fresh = join(root, ".trash", `juliet-${Date.now()}`);
    for (const dir of [leftover, expired, fresh]) mkdirSync(dir, { recursive: true });

    await __test__.reapRepoTrash({ repoName: "acme", repoPath: repo, log: fakeLog() });

    await waitFor(() => !existsSync(leftover) && !existsSync(expired));
    expect(existsSync(fresh)).toBe(true);
  });

  // S079: sanitizeRoot (lib/worktree/config.ts) has no ancestor check, so a
  // repo configured with e.g. `root: "${repoRoot}/.."` makes the crash sweep
  // walk the parent directory of every sibling repo for `.trash-*` names.
  test("refuses a configured root outside the repo and warns instead of sweeping it", async () => {
    const parent = dirname(repo);
    const siblingLeftover = join(parent, ".trash-should-survive-123");
    mkdirSync(siblingLeftover, { recursive: true });
    await declareWorktrees(repo, "acme", { root: parent });

    const warns: unknown[][] = [];
    const log = { info: () => {}, warn: (...a: unknown[]) => warns.push(a), error: () => {}, debug: () => {} } as unknown as Logger;

    await __test__.reapRepoTrash({ repoName: "acme", repoPath: repo, log });
    await new Promise((r) => setTimeout(r, 300)); // give a wrongly-spawned detached rm time to run

    expect(existsSync(siblingLeftover)).toBe(true);
    expect(warns.some((w) => JSON.stringify(w).includes(parent))).toBe(true);
  });
});

// S089: a provision's cold createTree and the reconciler's own replenish
// createTree can run concurrently for the same repo, both `git fetch origin
// <branch>` against the same repoPath — the loser fails to lock
// refs/remotes/origin/<branch>, and that failure gets charged to
// createBackoff (a 5-to-30-minute replenish hold) for what was really just
// contention, not a genuine failure. Serializing createTree per repoPath
// closes the race at its root.
describe("withCreateLock", () => {
  test("serializes concurrent calls for the same repoPath — never two holders at once", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = (id: string) => withCreateLock("/repo/a", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end-${id}`);
      active--;
    });
    await Promise.all([run("1"), run("2"), run("3")]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  test("different repoPaths are not serialized against each other", async () => {
    let active = 0;
    let maxActive = 0;
    const run = (path: string) => withCreateLock(path, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    await Promise.all([run("/repo/b"), run("/repo/c")]);
    expect(maxActive).toBe(2);
  });

  test("a holder that throws still releases the lock for the next caller", async () => {
    await expect(withCreateLock("/repo/d", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    let ran = false;
    await withCreateLock("/repo/d", async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

test("both cold-create call sites in handlers/worktree.ts serialize createTree through the shared per-repo lock (S089)", () => {
  const source = readFileSync(new URL("../handlers/worktree.ts", import.meta.url), "utf8");
  const matches = source.match(/withCreateLock\(/g) ?? [];
  expect(matches.length).toBeGreaterThanOrEqual(2);
});
