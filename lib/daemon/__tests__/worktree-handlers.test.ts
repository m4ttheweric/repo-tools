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
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import type { Logger } from "pino";
import { writeJson } from "../../json-store.ts";
import { repoDataDir, rtDir } from "../../rt-paths.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../../worktree/registry.ts";
import { tryLockTree } from "../../worktree/locks.ts";
import { branchExistsLocalAsync, currentBranchAsync, headSha } from "../../worktree/git-async.ts";
import { createWorktreeHandlers, isClaimable } from "../handlers/worktree.ts";
import type { HandlerContext, HandlerMap } from "../handlers/types.ts";
import { fakeStore } from "./fake-cache-store.ts";

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
  const ctx = {
    cache: fakeStore(entries),
    repoIndex: () => repos,
    log: fakeLog(),
    refreshCache: async () => {},
  } as unknown as HandlerContext;
  const h = createWorktreeHandlers(ctx, {
    emit: (type: string, data: unknown) => events.push({ type, data: data as any }),
    kick: () => { state.kicks++; },
    creationInFlight: () => null,
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

const repoName = "acme";

beforeEach(() => {
  process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtwh-home-")));
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

  test("a ready step that fails after the claim hands the tree over flagged", async () => {
    const repo = makeRepo();
    writeJson(join(repoDataDir(repoName), "config.json"), {
      worktrees: { ready: [{ run: "exit 3" }] },
    });
    seedOnDeck(repo, repoName, "alpha", new Date().toISOString());
    const { h } = makeHandlers({ [repoName]: repo });

    const res: any = await h["worktree:provision"]!({ repoName, branch: "rt-9-degraded" });

    // Non-fatal: the caller has a usable tree, but must be able to see that
    // its readiness is degraded.
    expect(res.ok).toBe(true);
    expect(res.data.readyFailed).toBe(true);
    expect(res.data.failedStep).toBe("exit 3");
    expect(loadRegistry(repoName).find((t) => t.name === "alpha")!.state).toBe("claimed");
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
  test("registers main, disposes a clean parking-lot tree, claims the feature tree", async () => {
    const repo = makeRepo();
    const parked = join(repo, ".worktrees", "parked");
    const feature = join(repo, ".worktrees", "feature");
    sh(`git worktree add -b parking-lot/1 ${parked} origin/main`, repo);
    sh(`git worktree add -b cv-1-feature ${feature} origin/main`, repo);

    const repoIndexPath = join(repoDataDir(repoName), "parking-lot.json");
    const appStatePath = join(rtDir(), "parking-lot-state.json");
    writeJson(repoIndexPath, { [parked]: { branch: "parking-lot/1" } });
    writeJson(appStatePath, { transitions: [] });

    const { h } = makeHandlers({ [repoName]: repo });
    const res: any = await h["worktree:adopt"]!({ repoName });

    expect(res.ok).toBe(true);
    expect(res.data.main).toBe(basename(repo));
    expect(res.data.disposed).toEqual(["parked"]);
    expect(res.data.claimed).toEqual(["feature"]);
    expect(res.data.refused).toEqual([]);

    expect(existsSync(parked)).toBe(false);
    expect(await branchExistsLocalAsync(repo, "parking-lot/1")).toBe(false);

    const trees = loadRegistry(repoName);
    expect(trees.find((t) => t.path === repo)!.kind).toBe("main");
    expect(trees.find((t) => t.name === "parked")).toBeUndefined();
    const feat = trees.find((t) => t.name === "feature")!;
    expect(feat.kind).toBe("ephemeral");
    expect(feat.state).toBe("claimed");
    expect(feat.disposal).toBe("merge");
    expect(feat.branch).toBe("cv-1-feature");

    expect(existsSync(repoIndexPath)).toBe(false);
    expect(existsSync(appStatePath)).toBe(false);
  });
});
