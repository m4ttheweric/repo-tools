/**
 * Handler-level tests for the worktree IPC verbs (spec §3/§7/§11.2).
 *
 * Real git repos (bare-clone origins, realpath'd tmpdirs per the fixture
 * rule) plus a stub HandlerContext: the handlers are exercised exactly as the
 * daemon calls them, so payload/data contracts and the provision matrix are
 * asserted against ground truth rather than mocks.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { Logger } from "pino";
import { writeJson } from "../../json-store.ts";
import { machineSettingsPath, repoDataDir, rtDir } from "../../rt-paths.ts";
import { deriveRepoIdentity } from "../../settings/identity.ts";
import { closeStateDb } from "../../state/index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../../worktree/registry.ts";
import { readyTaskFor } from "../../worktree/ready-async.ts";
import { tryLockTree } from "../../worktree/locks.ts";
import { branchExistsLocalAsync, currentBranchAsync, headSha } from "../../worktree/git-async.ts";
import {
  backoffNote,
  createFailedError,
  createWorktreeHandlers,
  isClaimable,
} from "../handlers/worktree.ts";
import type { HandlerContext, HandlerMap } from "../handlers/types.ts";
import { fakeStore } from "./fake-cache-store.ts";

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
 * Gives `repoPath` a resolvable settings identity, pinning its (local
 * bare-clone) origin via the machine store's `rt.repoIdentityOverrides` when
 * it doesn't itself normalize — exactly the fork/local-remote mechanism
 * production uses.
 */
async function ensureIdentity(repoPath: string, repoName: string): Promise<string> {
  const remote = execSync("git config --get remote.origin.url", { cwd: repoPath, encoding: "utf8" }).trim();
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

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, shell: "/bin/zsh", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** A repo on `main` with one commit and a bare clone wired up as origin. */
function makeRepo(prefix = "rtwh-"): string {
  // realpathSync: git canonicalizes /var -> /private/var on macOS (fixture rule)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  sh("git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init", dir);
  const bare = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}bare-`)));
  sh(`git clone --bare ${dir} ${bare}/o.git && git -C ${dir} remote add origin ${bare}/o.git && git -C ${dir} fetch origin`);
  return dir;
}

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

interface Harness {
  h: HandlerMap;
  events: Array<{ type: string; data: any }>;
  kicks: number;
}

function makeHandlers(
  repos: Record<string, string>,
  entries: Record<string, any> = {},
): Harness {
  const events: Array<{ type: string; data: any }> = [];
  const state = { kicks: 0 };
  const ctx: Pick<HandlerContext, "repoIndex" | "cache" | "log"> = {
    cache: fakeStore(entries),
    repoIndex: () => repos,
    log: fakeLog(),
  };
  const h = createWorktreeHandlers(ctx, {
    emit: (type: string, data: unknown) => events.push({ type, data: data as any }),
    kick: () => { state.kicks++; },
    creationInFlight: () => null,
    withReconcilerHeld: async (fn) => fn(),
  });
  return {
    h,
    events,
    get kicks() { return state.kicks; },
  } as Harness;
}

/** Register a real on-deck worktree (git + registry) without paying createTree. */
function seedOnDeck(repo: string, repoName: string, name: string, readyAt: string): TreeRecord {
  const path = join(repo, ".worktrees", name);
  sh(`git worktree add -b on-deck/${name} ${path} origin/main`, repo);
  const rec: TreeRecord = {
    name, path,
    kind: "ephemeral",
    state: "on-deck",
    branch: `on-deck/${name}`,
    createdAt: readyAt,
    readyAt,
  };
  const trees = loadRegistry(repoName);
  trees.push(rec);
  saveRegistry(repoName, trees);
  return rec;
}

/** Register a real claimed worktree on its own branch. */
function seedClaimed(repo: string, repoName: string, name: string, branch: string, owner?: string): TreeRecord {
  const path = join(repo, ".worktrees", name);
  sh(`git worktree add -b ${branch} ${path} origin/main`, repo);
  const rec: TreeRecord = {
    name, path,
    kind: "ephemeral",
    state: "claimed",
    branch,
    createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(),
    disposal: "merge",
    ...(owner ? { owner } : {}),
  };
  const trees = loadRegistry(repoName);
  trees.push(rec);
  saveRegistry(repoName, trees);
  return rec;
}

// Hard cutover: every worktree handler now refuses a bare legacy name
// before it ever reaches the (identity-keyed) registry, so this fixture must
// itself be a syntactically valid serialized identity, not a plain name.
const repoName = "remote:acme";

beforeEach(() => {
  process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtwh-home-")));
  closeStateDb();
  // killProcesses off: the process killer shells out to ps/lsof and has
  // nothing to find in a fixture.
  writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
});

describe("worktree:provision", () => {
  test("claims an on-deck tree onto the derived branch and emits worktree:claimed", async () => {
    const repo = makeRepo();
    const rec = seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h, events } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({
      repoName, ticket: "RT-99", ticketTitle: "Do the thing", owner: "pane-1",
    });

    expect(res.ok).toBe(true);
    expect(res.data.tree).toBe("alpha");
    expect(res.data.wasOnDeck).toBe(true);
    expect(res.data.branch).toBe("rt-99-do-the-thing");
    expect(res.data.branchState).toBe("new");
    expect(res.data.readyAt).toBe(rec.readyAt!);

    expect(await currentBranchAsync(rec.path)).toBe("rt-99-do-the-thing");
    expect(await branchExistsLocalAsync(repo, "on-deck/alpha")).toBe(false);

    const stored = loadRegistry(repoName).find((t) => t.name === "alpha")!;
    expect(stored.state).toBe("claimed");
    expect(stored.owner).toBe("pane-1");
    expect(stored.disposal).toBe("merge");
    expect(stored.branch).toBe("rt-99-do-the-thing");
    expect(stored.claimedAt).toBeTruthy();

    const claimed = events.find((e) => e.type === "worktree:claimed");
    expect(claimed).toBeDefined();
    expect(claimed!.data).toMatchObject({ repo: repoName, tree: "alpha", branch: "rt-99-do-the-thing", owner: "pane-1" });
  });

  test("a delivered claim carries handoff done; the reply is the last writer (RT-99)", async () => {
    const repo = makeRepo();
    seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-99-handoff" });

    expect(res.ok).toBe(true);
    const stored = loadRegistry(repoName).find((t) => t.name === "alpha")!;
    expect(stored.handoff).toBe("done");
  });

  test("refuses a branch attached to another tree before touching the registry", async () => {
    const repo = makeRepo();
    seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    seedClaimed(repo, repoName, "beta", "rt-1-taken");
    const before = JSON.stringify(loadRegistry(repoName));
    const { h, events } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-1-taken" });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("branch-attached:beta");
    expect(JSON.stringify(loadRegistry(repoName))).toBe(before);
    expect(events.length).toBe(0);
  });

  test("refuses a branch duplicated across trees", async () => {
    const repo = makeRepo();
    const trees: TreeRecord[] = [
      { name: "a", path: join(repo, ".worktrees", "a"), kind: "ephemeral", state: "claimed", branch: "dup", createdAt: new Date().toISOString() },
      { name: "b", path: join(repo, ".worktrees", "b"), kind: "ephemeral", state: "claimed", branch: "dup", createdAt: new Date().toISOString() },
    ];
    saveRegistry(repoName, trees);
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "dup" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("branch-duplicated");
  });

  test("unknown repo refuses", async () => {
    const { h } = makeHandlers({});
    const res: any = await h["worktree:provision"]!({ repoName: "nope", branch: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("repo-unknown");
  });

  test("S010: refuses a branch that git would parse as an option, before any git call", async () => {
    const repo = makeRepo();
    const { h, events } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "--upload-pack=touch /tmp/x" });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("unsafe git ref");
    expect(events.length).toBe(0);
  });

  test("Hard cutover: a bare legacy name refuses even when it IS a registered repoIndex key", async () => {
    const repo = makeRepo();
    // Registered under a non-identity key on purpose — proves the rejection
    // is the identity-shape gate, not just an unregistered-name miss.
    const { h } = makeHandlers({ "acme-legacy": repo });
    const res: any = await h["worktree:provision"]!({ repoName: "acme-legacy", branch: "x" });
    expect(res).toEqual({ ok: false, error: "repo-unknown" });
  });

  test("cold-creates when the pool is empty (wasOnDeck false)", async () => {
    const repo = makeRepo();
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, ticket: "RT-7", ticketTitle: "Cold" });

    expect(res.ok).toBe(true);
    expect(res.data.wasOnDeck).toBe(false);
    expect(res.data.branch).toBe("rt-7-cold");
    expect(existsSync(res.data.path)).toBe(true);
    expect(await currentBranchAsync(res.data.path)).toBe("rt-7-cold");

    const stored = loadRegistry(repoName).find((t) => t.name === res.data.tree)!;
    expect(stored.state).toBe("claimed");
    expect(stored.kind).toBe("ephemeral");
  });

  test("a branch that exists only on the remote is checked out tracking it", async () => {
    const repo = makeRepo();
    // A teammate's branch: pushed to origin, never present locally.
    sh("git -c user.email=t@t -c user.name=t checkout -q -b tmp-mate && git -c user.email=t@t -c user.name=t commit --allow-empty -m mate", repo);
    const mateSha = sh("git rev-parse HEAD", repo).trim();
    sh("git push -q origin tmp-mate:refs/heads/mate-branch && git checkout -q main && git branch -qD tmp-mate", repo);

    const rec = seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "mate-branch" });

    expect(res.ok).toBe(true);
    expect(res.data.branchState).toBe("tracking-remote");
    expect(await headSha(rec.path)).toBe(mateSha);
    expect(await currentBranchAsync(rec.path)).toBe("mate-branch");
  });

  test("local branches report existing-clean, behind, or diverged and are never reconciled", async () => {
    const repo = makeRepo();
    const gitId = "git -c user.email=t@t -c user.name=t";

    // (c) local only, no upstream at all.
    sh(`${gitId} branch feat-local origin/main`, repo);

    // (c) local trails its upstream: origin's copy gained a commit the local ref never saw.
    sh(`${gitId} checkout -q -b feat-behind origin/main && git push -q origin feat-behind`, repo);
    sh(`${gitId} commit -q --allow-empty -m ahead && git push -q origin feat-behind && ${gitId} reset -q --hard HEAD~1 && git checkout -q main`, repo);

    // (e) both sides moved independently.
    sh(`${gitId} checkout -q -b tmp-div origin/main && ${gitId} commit -q --allow-empty -m theirs && git push -q origin tmp-div:refs/heads/feat-div && git checkout -q main && git branch -qD tmp-div`, repo);
    sh(`${gitId} checkout -q -b feat-div origin/main && ${gitId} commit -q --allow-empty -m mine && git checkout -q main`, repo);
    const mineSha = sh("git rev-parse feat-div", repo).trim();

    seedOnDeck(repo, repoName, "one", new Date().toISOString());
    seedOnDeck(repo, repoName, "two", new Date().toISOString());
    seedOnDeck(repo, repoName, "three", new Date().toISOString());
    const { h } = makeHandlers({ [repoName]: repo });

    const plain: any = await h["worktree:provision"]!({ repoName, branch: "feat-local" });
    expect(plain.data.branchState).toBe("existing-clean");

    const behind: any = await h["worktree:provision"]!({ repoName, branch: "feat-behind" });
    expect(behind.data.branchState).toBe("behind");

    const diverged: any = await h["worktree:provision"]!({ repoName, branch: "feat-div" });
    expect(diverged.data.branchState).toBe("diverged");
    // Reported, never reconciled: the local tip is checked out untouched.
    expect(await headSha(diverged.data.path)).toBe(mineSha);
  });

  test("a failure after the claim rolls the tree back to on-deck", async () => {
    const repo = makeRepo();
    const rec = seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    // Unreachable origin: the targeted fetch fails with something that is NOT
    // git's ref-not-found signature, which must roll back rather than proceed.
    sh(`git remote set-url origin ${join(tmpdir(), "rtwh-gone-nowhere.git")}`, repo);
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-5-boom", owner: "pane-1" });

    expect(res.ok).toBe(false);
    expect(String(res.error).startsWith("checkout-failed:")).toBe(true);

    const stored = loadRegistry(repoName).find((t) => t.name === "alpha")!;
    expect(stored.state).toBe("on-deck");
    expect(stored.owner).toBeUndefined();
    expect(stored.claimedAt).toBeUndefined();
    expect(stored.branch).toBe("on-deck/alpha");
    expect(await currentBranchAsync(rec.path)).toBe("on-deck/alpha");
  });

  test("only an on-deck entry is still claimable when the lock is finally taken", () => {
    const base: TreeRecord = {
      name: "alpha",
      path: "/tmp/alpha",
      kind: "ephemeral",
      state: "on-deck",
      branch: "on-deck/alpha",
      createdAt: new Date().toISOString(),
    };
    expect(isClaimable(base)).toBe(true);
    // `claimed` is precisely "another provision got here first": re-claiming
    // would overwrite that caller's owner/disposal and re-checkout their tree.
    expect(isClaimable({ ...base, state: "claimed" })).toBe(false);
    expect(isClaimable({ ...base, state: "creating" })).toBe(false);
    expect(isClaimable({ ...base, state: "disposable" })).toBe(false);
    expect(isClaimable({ ...base, kind: "unmanaged", state: undefined })).toBe(false);
    expect(isClaimable(undefined)).toBe(false);
  });

  test("a tree that has already left its on-deck branch flips disposable on failure", async () => {
    const repo = makeRepo();
    const rec = seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    // Registry drift: the tree is off its pool branch while the registry still
    // says on-deck, so the rollback has no on-deck branch to return it to.
    sh("git checkout -q -b drifted", rec.path);
    sh(`git remote set-url origin ${join(tmpdir(), "rtwh-gone-nowhere.git")}`, repo);
    const { h, events } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-8-boom", owner: "pane-1" });

    expect(res.ok).toBe(false);
    expect(String(res.error).startsWith("checkout-failed:")).toBe(true);

    const stored = loadRegistry(repoName).find((t) => t.name === "alpha")!;
    expect(stored.state).toBe("disposable");
    expect(stored.branch).toBe("drifted");
    expect(String(stored.disposableReason).startsWith("checkout-failed:")).toBe(true);

    const flipped = events.find((e) => e.type === "worktree:disposable");
    expect(flipped).toBeDefined();
    expect(flipped!.data).toMatchObject({ repo: repoName, tree: "alpha", branch: "drifted" });
    expect(String(flipped!.data.reason).startsWith("checkout-failed:")).toBe(true);
  });

  test("wait:true — a ready step that fails after the claim hands the tree over flagged", async () => {
    const repo = makeRepo();
    await declareWorktrees(repo, repoName, { ready: [{ run: "exit 3" }] });
    seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-9-degraded", wait: true });

    // Non-fatal: the caller has a usable tree, but must be able to see that
    // its readiness is degraded.
    expect(res.ok).toBe(true);
    expect(res.data.readyFailed).toBe(true);
    expect(res.data.failedStep).toBe("exit 3");
    expect(res.data.readyPending).toBeUndefined();
    const stored = loadRegistry(repoName).find((t) => t.name === "alpha")!;
    expect(stored.state).toBe("claimed");
    expect(stored.readyFailure).toBe("exit 3");
    expect(stored.readyPendingAt).toBeUndefined();
  });

  test("RT-96: triggered steps queue to a background task and provision returns immediately", async () => {
    const repo = makeRepo();
    await declareWorktrees(repo, repoName, { ready: [{ run: "sleep 0.2 && echo ran >> settle-marker.txt" }] });
    seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h, events } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-96-async" });

    expect(res.ok).toBe(true);
    expect(res.data.readyPending).toBe(true);
    expect(res.data.readySteps).toEqual(["sleep 0.2 && echo ran >> settle-marker.txt"]);
    expect(res.data.readyHeld).toBe(false);
    expect(res.data.readyAt).toBeNull();
    const stored = loadRegistry(repoName).find((t) => t.name === "alpha")!;
    expect(stored.readyPendingAt).toBeTruthy();

    const task = readyTaskFor(res.data.path);
    expect(task).not.toBeNull();
    const settle = await task!;
    expect(settle.ok).toBe(true);
    expect(existsSync(join(res.data.path, "settle-marker.txt"))).toBe(true);
    const settled = loadRegistry(repoName).find((t) => t.name === "alpha")!;
    expect(settled.readyPendingAt).toBeUndefined();
    expect(settled.readyAt).toBeTruthy();
    expect(events.find((e) => e.type === "worktree:ready-settled")?.data).toMatchObject({
      repo: repoName, tree: "alpha", ok: true,
    });
  });

  test("RT-96: wait:true blocks until the steps settle and stamps readyAt", async () => {
    const repo = makeRepo();
    await declareWorktrees(repo, repoName, { ready: [{ run: "true" }] });
    seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h, events } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-96-wait", wait: true });

    expect(res.ok).toBe(true);
    expect(res.data.readyPending).toBeUndefined();
    expect(res.data.readyAt).toBeTruthy();
    expect(events.find((e) => e.type === "worktree:ready-settled")?.data).toMatchObject({ ok: true });
  });

  test("skips a locked on-deck tree and picks the next best", async () => {
    const repo = makeRepo();
    const older = new Date(Date.now() - 60_000).toISOString();
    seedOnDeck(repo, repoName, "alpha", older);
    const beta = seedOnDeck(repo, repoName, "beta", new Date().toISOString());

    const release = tryLockTree(beta.path);
    expect(release).not.toBeNull();
    try {
      const { h } = makeHandlers({ [repoName]: repo });
      const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-2-pick" });
      expect(res.ok).toBe(true);
      // beta is the freshest but locked, so the claim falls to alpha.
      expect(res.data.tree).toBe("alpha");
    } finally {
      release!();
    }
  });
});

describe("worktree:await-ready", () => {
  test("joins the in-flight settle from an async provision and reports readiness", async () => {
    const repo = makeRepo();
    await declareWorktrees(repo, repoName, { ready: [{ run: "sleep 0.2 && echo ran >> settle-marker.txt" }] });
    seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h } = makeHandlers({ [repoName]: repo });

    const prov: any = await h["worktree:provision"]!({ repoName, branch: "rt-96-join" });
    expect(prov.data.readyPending).toBe(true);

    const res: any = await h["worktree:await-ready"]!({ repoName, tree: "alpha" });

    expect(res.ok).toBe(true);
    expect(res.data.ready).toBe(true);
    expect(res.data.readyAt).toBeTruthy();
    expect(existsSync(join(prov.data.path, "settle-marker.txt"))).toBe(true);
  });

  test("a settled failure is reported from the registry without re-running anything", async () => {
    const repo = makeRepo();
    const rec = seedClaimed(repo, repoName, "alpha", "rt-96-failed");
    const trees = loadRegistry(repoName).map((t) =>
      t.path === rec.path ? { ...t, readyFailure: "exit 3" } : t,
    );
    saveRegistry(repoName, trees);
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:await-ready"]!({ repoName, tree: "alpha" });

    expect(res.ok).toBe(true);
    expect(res.data.ready).toBe(false);
    expect(res.data.failedStep).toBe("exit 3");
  });

  test("an orphaned pending marker (daemon restart) is recovered by re-running the steps", async () => {
    const repo = makeRepo();
    await declareWorktrees(repo, repoName, { ready: [{ run: "echo ran >> recover-marker.txt" }] });
    const rec = seedClaimed(repo, repoName, "alpha", "rt-96-orphan");
    const trees = loadRegistry(repoName).map((t) =>
      t.path === rec.path ? { ...t, readyPendingAt: new Date().toISOString() } : t,
    );
    saveRegistry(repoName, trees);
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:await-ready"]!({ repoName, tree: "alpha" });

    expect(res.ok).toBe(true);
    expect(res.data.ready).toBe(true);
    expect(existsSync(join(rec.path, "recover-marker.txt"))).toBe(true);
    const settled = loadRegistry(repoName).find((t) => t.path === rec.path)!;
    expect(settled.readyPendingAt).toBeUndefined();
    expect(settled.readyAt).toBeTruthy();
  });

  test("an unknown tree refuses", async () => {
    const repo = makeRepo();
    const { h } = makeHandlers({ [repoName]: repo });
    const res: any = await h["worktree:await-ready"]!({ repoName, tree: "ghost" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("tree-unknown");
  });
});

describe("worktree:create", () => {
  test("--on-deck leaves the tree in the pool; without it the tree is claimed", async () => {
    const repo = makeRepo();
    const { h } = makeHandlers({ [repoName]: repo });

    const pooled: any = await h["worktree:create"]!({ repoName, onDeck: true });
    expect(pooled.ok).toBe(true);
    expect(loadRegistry(repoName).find((t) => t.name === pooled.data.tree)!.state).toBe("on-deck");

    const claimed: any = await h["worktree:create"]!({ repoName });
    expect(claimed.ok).toBe(true);
    expect(existsSync(claimed.data.path)).toBe(true);
    expect(loadRegistry(repoName).find((t) => t.name === claimed.data.tree)!.state).toBe("claimed");
  });

  test("Hard cutover: a bare legacy name refuses even when registered", async () => {
    const repo = makeRepo();
    const { h } = makeHandlers({ "acme-legacy": repo });
    const res: any = await h["worktree:create"]!({ repoName: "acme-legacy" });
    expect(res).toEqual({ ok: false, error: "repo-unknown" });
  });
});

describe("Hard cutover: bare legacy names on the sweep verbs (dispose/list/freshen)", () => {
  test("dispose/list/freshen all refuse a bare legacy repoName even when registered", async () => {
    const repo = makeRepo();
    const { h } = makeHandlers({ "acme-legacy": repo });

    const disposed: any = await h["worktree:dispose"]!({ repoName: "acme-legacy", tree: "whatever" });
    expect(disposed).toEqual({ ok: false, error: "repo-unknown" });

    const listed: any = await h["worktree:list"]!({ repoName: "acme-legacy" });
    expect(listed).toEqual({ ok: false, error: "repo-unknown" });

    const freshened: any = await h["worktree:freshen"]!({ repoName: "acme-legacy" });
    expect(freshened).toEqual({ ok: false, error: "repo-unknown" });
  });
});

describe("worktree:dispose", () => {
  test("a locked tree gets the typed busy refusal", async () => {
    const repo = makeRepo();
    const rec = seedClaimed(repo, repoName, "alpha", "rt-3-work");
    const release = tryLockTree(rec.path);
    try {
      const { h } = makeHandlers({ [repoName]: repo });
      const res: any = await h["worktree:dispose"]!({ repoName, tree: "alpha" });
      expect(res.ok).toBe(true);
      expect(res.data.disposed).toEqual([]);
      expect(res.data.refused).toEqual([{ tree: "alpha", reason: "busy" }]);
    } finally {
      release!();
    }
  });

  test("--owner sweeps every repo and reports the dirty tree's refusal", async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    const clean = seedClaimed(repoA, "acme", "alpha", "rt-4-clean", "job-1");
    const dirty = seedClaimed(repoB, "beta-repo", "bravo", "rt-4-dirty", "job-1");
    writeFileSync(join(dirty.path, "scratch.txt"), "uncommitted\n");

    const { h } = makeHandlers({ acme: repoA, "beta-repo": repoB });
    const res: any = await h["worktree:dispose"]!({ owner: "job-1" });

    expect(res.ok).toBe(true);
    expect(res.data.disposed).toEqual(["alpha"]);
    expect(res.data.refused).toEqual([{ tree: "bravo", reason: "dirty" }]);
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    expect(loadRegistry("acme").find((t) => t.name === "alpha")).toBeUndefined();
    expect(loadRegistry("beta-repo").find((t) => t.name === "bravo")).toBeDefined();
  });

  test("a successful dispose reports where the tree stays recoverable", async () => {
    const repo = makeRepo();
    const rec = seedClaimed(repo, repoName, "alpha", "rt-51-recover");

    const { h } = makeHandlers({ [repoName]: repo });
    const res: any = await h["worktree:dispose"]!({ repoName, tree: "alpha" });

    expect(res.ok).toBe(true);
    expect(res.data.disposed).toEqual(["alpha"]);
    expect(res.data.recoverable).toHaveLength(1);
    const entry = res.data.recoverable[0];
    expect(entry.tree).toBe("alpha");
    expect(entry.path).toContain(join(".worktrees", ".trash"));
    expect(existsSync(entry.path)).toBe(true);
    expect(Date.parse(entry.until)).toBeGreaterThan(Date.now());
    expect(existsSync(rec.path)).toBe(false);
  });

  test("a bare tree name matching two repos refuses rather than guessing", async () => {
    const repoA = makeRepo();
    const repoB = makeRepo();
    seedClaimed(repoA, "acme", "alpha", "rt-6-a");
    seedClaimed(repoB, "beta-repo", "alpha", "rt-6-b");

    const { h } = makeHandlers({ acme: repoA, "beta-repo": repoB });
    const res: any = await h["worktree:dispose"]!({ tree: "alpha" });

    expect(res.ok).toBe(false);
    expect(res.error).toBe("tree-ambiguous");
    expect(loadRegistry("acme").length).toBe(1);
    expect(loadRegistry("beta-repo").length).toBe(1);
  });
});

describe("worktree:restore", () => {
  test.each(["..", ".", "a/b", "../evil", "a\\b", "..\\evil"])(
    "rejects treeName %j before locking or calling restoreTree",
    async (bad) => {
      const repo = makeRepo();
      const { h } = makeHandlers({ [repoName]: repo });
      const res: any = await h["worktree:restore"]!({ repoName, tree: bad });
      expect(res).toMatchObject({ ok: false, error: "no-target" });
    },
    20_000,
  );

  test("a normal treeName is not rejected by validation (reaches restoreTree)", async () => {
    const repo = makeRepo();
    const { h } = makeHandlers({ [repoName]: repo });
    // No retained entry exists for "alpha", so a treeName that clears
    // validation surfaces restoreTree's own not-found, proving the guard
    // did not swallow a legitimate name.
    const res: any = await h["worktree:restore"]!({ repoName, tree: "alpha" });
    expect(res).toMatchObject({ ok: false, error: "not-found" });
  });
});

describe("worktree:list", () => {
  test("flags duplicate branches and joins MRs on (repoName, branch)", async () => {
    const repo = makeRepo();
    const now = new Date().toISOString();
    saveRegistry(repoName, [
      { name: "a", path: join(repo, ".worktrees", "a"), kind: "ephemeral", state: "claimed", branch: "dup", createdAt: now },
      { name: "b", path: join(repo, ".worktrees", "b"), kind: "ephemeral", state: "claimed", branch: "dup", createdAt: now },
      { name: "c", path: join(repo, ".worktrees", "c"), kind: "ephemeral", state: "claimed", branch: "solo", createdAt: now },
      { name: "d", path: join(repo, ".worktrees", "d"), kind: "ephemeral", state: "claimed", branch: "other-repo", createdAt: now },
    ]);
    const entries = {
      solo: { mr: { iid: 7, state: "opened", title: "Solo work" }, repoName },
      "other-repo": { mr: { iid: 9, state: "opened", title: "Not ours" }, repoName: "elsewhere" },
    };
    const { h } = makeHandlers({ [repoName]: repo }, entries);

    const res: any = await h["worktree:list"]!({ repoName });
    expect(res.ok).toBe(true);
    const byName: Record<string, any> = Object.fromEntries(res.data.trees.map((t: any) => [t.name, t]));

    expect(byName.a.duplicateBranch).toBe(true);
    expect(byName.b.duplicateBranch).toBe(true);
    expect(byName.c.duplicateBranch).toBeUndefined();
    expect(byName.c.mr).toMatchObject({ iid: 7, state: "opened", title: "Solo work" });
    // repoName mismatch means "no MR", never another repo's MR.
    expect(byName.d.mr).toBeNull();
  });

  test("S077: a declared pool on a dormant (app-disabled) machine surfaces dormant + the enable command", async () => {
    const repo = makeRepo();
    await declareWorktrees(repo, repoName, { onDeck: 1 });
    writeJson(join(rtDir(), "worktrees.json"), { enabled: false, killProcesses: false });
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:list"]!({ repoName });

    expect(res.ok).toBe(true);
    expect(res.data.dormant).toBe(true);
    expect(res.data.dormantRepos).toEqual([repoName]);
    expect(res.data.message).toContain('rt settings set rt.worktreeApp \'{"enabled":true}\' --scope machine');
  });

  test("an owned machine with a declared pool never reports dormant", async () => {
    const repo = makeRepo();
    await declareWorktrees(repo, repoName, { onDeck: 1 });
    const { h } = makeHandlers({ [repoName]: repo }); // top-level beforeEach already writes enabled: true

    const res: any = await h["worktree:list"]!({ repoName });

    expect(res.ok).toBe(true);
    expect(res.data.dormant).toBeUndefined();
  });
});

describe("worktree:freshen", () => {
  test("runs the named tree and fast-forwards it", async () => {
    const repo = makeRepo();
    const rec = seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const before = await headSha(rec.path);
    sh("git -c user.email=t@t -c user.name=t commit --allow-empty -m advance && git push -q origin main", repo);

    const { h } = makeHandlers({ [repoName]: repo });
    const res: any = await h["worktree:freshen"]!({ repoName, tree: "alpha" });

    expect(res.ok).toBe(true);
    expect(res.data.ran).toEqual(["alpha"]);
    expect(await headSha(rec.path)).not.toBe(before);
  });
});

describe("worktree:adopt", () => {
  test("registers main, disposes a clean parking-lot tree, leaves the foreign feature tree unmanaged", async () => {
    const repo = makeRepo();
    const parked = join(repo, ".worktrees", "parked");
    const feature = join(repo, ".worktrees", "feature");
    sh(`git worktree add -b parking-lot/1 ${parked} origin/main`, repo);
    sh(`git worktree add -b acme-1-feature ${feature} origin/main`, repo);

    const repoIndexPath = join(repoDataDir(repoName), "parking-lot.json");
    const appStatePath = join(rtDir(), "parking-lot-state.json");
    writeJson(repoIndexPath, { [parked]: { branch: "parking-lot/1" } });
    writeJson(appStatePath, { transitions: [] });

    const { h } = makeHandlers({ [repoName]: repo });
    const res: any = await h["worktree:adopt"]!({ repoName });

    expect(res.ok).toBe(true);
    expect(res.data.main).toBe(basename(repo));
    expect(res.data.disposed).toEqual(["parked"]);
    expect(res.data.claimed).toEqual([]);
    expect(res.data.unmanaged).toEqual(["feature"]);
    expect(res.data.refused).toEqual([]);

    expect(existsSync(parked)).toBe(false);
    expect(await branchExistsLocalAsync(repo, "parking-lot/1")).toBe(false);

    const trees = loadRegistry(repoName);
    expect(trees.find((t) => t.path === repo)!.kind).toBe("main");
    expect(trees.find((t) => t.name === "parked")).toBeUndefined();
    const feat = trees.find((t) => t.name === "feature")!;
    expect(feat.kind).toBe("unmanaged");
    expect(feat.branch).toBe("acme-1-feature");

    expect(existsSync(repoIndexPath)).toBe(false);
    expect(existsSync(appStatePath)).toBe(false);
  });

  test("claims the foreign feature tree as ephemeral when --claim is passed", async () => {
    const repo = makeRepo();
    const feature = join(repo, ".worktrees", "feature");
    sh(`git worktree add -b acme-1-feature ${feature} origin/main`, repo);

    const { h } = makeHandlers({ [repoName]: repo });
    const res: any = await h["worktree:adopt"]!({ repoName, claim: true });

    expect(res.ok).toBe(true);
    expect(res.data.claimed).toEqual(["feature"]);
    expect(res.data.unmanaged).toEqual([]);

    const trees = loadRegistry(repoName);
    const feat = trees.find((t) => t.name === "feature")!;
    expect(feat.kind).toBe("ephemeral");
    expect(feat.state).toBe("claimed");
    expect(feat.disposal).toBe("merge");
    expect(feat.branch).toBe("acme-1-feature");
  });
});

describe("backoffNote", () => {
  const now = Date.parse("2026-08-21T16:20:00.000Z");
  const onDeck = (name: string, nextRetryAt?: string): TreeRecord => ({
    name,
    path: `/tmp/${name}`,
    kind: "ephemeral",
    state: "on-deck",
    branch: `on-deck/${name}`,
    createdAt: "2026-08-20T18:15:30.271Z",
    ...(nextRetryAt ? { nextRetryAt } : {}),
  });

  test("is null when no on-deck tree is held", () => {
    expect(backoffNote([onDeck("cho")], now)).toBeNull();
  });

  test("is null when a backoff has already expired", () => {
    expect(backoffNote([onDeck("cho", "2026-08-21T16:19:59.000Z")], now)).toBeNull();
  });

  test("counts held trees and names the earliest retry", () => {
    const note = backoffNote(
      [
        onDeck("cho", "2026-08-21T16:52:42.822Z"),
        onDeck("dean", "2026-08-21T16:35:05.233Z"),
        onDeck("dudley"),
      ],
      now,
    );

    expect(note).toBe("2 on-deck trees held by retry backoff until 2026-08-21T16:35:05.233Z");
  });

  test("singular for one held tree", () => {
    const note = backoffNote([onDeck("cho", "2026-08-21T16:52:42.822Z")], now);

    expect(note).toBe("1 on-deck tree held by retry backoff until 2026-08-21T16:52:42.822Z");
  });
});

describe("createFailedError", () => {
  test("keeps the prefix and output tail when there is no note", () => {
    const error = createFailedError({
      failedStep: "pnpm install",
      output: "env: node: No such file or directory",
    });

    expect(error).toBe("create-failed:pnpm install\nenv: node: No such file or directory");
  });

  test("appends the note as its own line", () => {
    const error = createFailedError(
      { failedStep: "pnpm install", output: "env: node: No such file or directory" },
      "2 on-deck trees held by retry backoff until 2026-08-21T16:35:05.233Z",
    );

    expect(error).toBe(
      "create-failed:pnpm install\nenv: node: No such file or directory\n" +
        "2 on-deck trees held by retry backoff until 2026-08-21T16:35:05.233Z",
    );
  });

  test("appends the note even with no output", () => {
    const error = createFailedError(
      { failedStep: "pnpm install" },
      "1 on-deck tree held by retry backoff until 2026-08-21T16:35:05.233Z",
    );

    expect(error).toBe(
      "create-failed:pnpm install\n1 on-deck tree held by retry backoff until 2026-08-21T16:35:05.233Z",
    );
  });
});
