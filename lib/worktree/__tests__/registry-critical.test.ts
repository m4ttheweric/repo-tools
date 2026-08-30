/**
 * S025: the registry and endpoint-claim writes are CRITICAL (busy.ts's
 * runCriticalWrite), not warn-and-drop. A dropped write must report failure
 * so a destructive caller (provision's claim, create's final flip) refuses
 * to act as though it landed, rather than advancing state nothing persisted.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { writeJson } from "../../json-store.ts";
import { rtDir } from "../../rt-paths.ts";
import { closeStateDb, getStateDb } from "../../state/index.ts";
import { setKvValueCritical } from "../../state/kv-blob.ts";
import { loadRegistry, saveRegistry, registryEpoch, type TreeRecord } from "../registry.ts";
import { tryLockTree } from "../locks.ts";
import { reconcileRepoRegistry } from "../../daemon/worktree-reconciler.ts";
import { createWorktreeHandlers } from "../../daemon/handlers/worktree.ts";
import { fakeStore } from "../../daemon/__tests__/fake-cache-store.ts";

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function sh(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, shell: "/bin/zsh", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** A repo on `main` with one commit and a bare clone wired up as origin. */
function makeRepo(prefix = "rtcrit-"): string {
  // realpathSync: git canonicalizes /var -> /private/var on macOS (fixture rule)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  sh("git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init", dir);
  const bare = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}bare-`)));
  sh(`git clone --bare ${dir} ${bare}/o.git && git -C ${dir} remote add origin ${bare}/o.git && git -C ${dir} fetch origin`);
  return dir;
}

function seedOnDeck(repo: string, repoName: string, name: string): TreeRecord {
  const path = join(repo, ".worktrees", name);
  sh(`git worktree add -b on-deck/${name} ${path} origin/main`, repo);
  const rec: TreeRecord = {
    name, path,
    kind: "ephemeral",
    state: "on-deck",
    branch: `on-deck/${name}`,
    createdAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
  };
  saveRegistry(repoName, [...loadRegistry(repoName), rec]);
  return rec;
}

function seedClaimed(repo: string, repoName: string, name: string, branch: string, owner: string): TreeRecord {
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
    owner,
  };
  saveRegistry(repoName, [...loadRegistry(repoName), rec]);
  return rec;
}

// Hard cutover: the worktree handlers refuse a bare legacy repoName before
// it reaches the registry, so this fixture must itself parse as a
// serialized identity.
const repoName = "remote:acme";

const rec = (over: Partial<TreeRecord>): TreeRecord => ({
  name: "bellatrix",
  path: "/tmp/x",
  kind: "ephemeral",
  state: "on-deck",
  branch: "on-deck/bellatrix",
  createdAt: new Date(0).toISOString(),
  ...over,
});

describe("setKvValueCritical", () => {
  test("returns false when the write stays busy", () => {
    const busy = {
      query: () => ({ run: () => { const e: any = new Error("busy"); e.code = "SQLITE_BUSY"; throw e; } }),
    } as any;
    expect(setKvValueCritical("ns", "k", { a: 1 }, busy)).toBe(false);
  });
});

describe("saveRegistry: routes through the critical write", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcrit-home-")));
    closeStateDb();
  });

  test("a write that stays busy through the retry budget returns false and does not bump the epoch or the stored value", () => {
    // "daemon" flavor's 250ms busy_timeout keeps the retry budget (3 attempts,
    // 20ms apart) well under a second; the singleton never upgrades back to
    // "cli"'s 5000ms once tightened (state/db.ts getStateDb).
    getStateDb("daemon");
    saveRegistry("r", [rec({ name: "before" })]);
    const epochBefore = registryEpoch("r");

    const dbPath = join(rtDir(), "state.db");
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    let ok: boolean;
    try {
      ok = saveRegistry("r", [rec({ name: "after" })]);
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    expect(ok).toBe(false);
    expect(registryEpoch("r")).toBe(epochBefore);
    expect(loadRegistry("r").map((t) => t.name)).toEqual(["before"]);
  }, 10_000);
});

describe("provision claim: a dropped write is refused, not silently accepted", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcrit-prov-")));
    closeStateDb();
    writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
  });

  test("a claim write that stays busy through the full retry budget refuses the provision, leaves the tree on-deck, fires no worktree:claimed, and never touches an unrelated already-claimed tree in the same registry", async () => {
    const repo = makeRepo();
    seedOnDeck(repo, repoName, "alpha");
    const beta = seedClaimed(repo, repoName, "beta", "feature/beta", "matt");

    const events: Array<{ type: string; data: any }> = [];
    const h = createWorktreeHandlers(
      { cache: fakeStore(), repoIndex: () => ({ [repoName]: repo }), log: fakeLog(), refreshCache: async () => {} } as any,
      {
        emit: (type, data) => events.push({ type, data }),
        kick: () => {},
        creationInFlight: () => null,
        withReconcilerHeld: async (fn) => fn(),
      },
    );

    getStateDb("daemon");
    const dbPath = join(rtDir(), "state.db");
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    let res: any;
    try {
      res = await h["worktree:provision"]!({ repoName, branch: "rt-crit-claim" });
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    expect(res.ok).toBe(false);
    expect(res.error).toBe("claim-write-failed");
    expect(events.find((e) => e.type === "worktree:claimed")).toBeUndefined();

    const trees = loadRegistry(repoName);
    const alpha = trees.find((t) => t.name === "alpha")!;
    expect(alpha.state).toBe("on-deck");
    expect(alpha.owner).toBeUndefined();

    // The registry is one JSON blob per repo (kv-blob.ts): a dropped write
    // writes nothing at all, so a tree that was already claimed and
    // persisted before this attempt is not re-handed by the failure.
    const stillBeta = trees.find((t) => t.name === "beta")!;
    expect(stillBeta.state).toBe("claimed");
    expect(stillBeta.owner).toBe("matt");
    expect(stillBeta.claimedAt).toBe(beta.claimedAt);
  }, 10_000);
});

describe("reconcile and an in-flight create's registry flip", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcrit-recon-")));
    closeStateDb();
    writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: false });
  });

  test("a completed build stuck in 'creating' (its flip write dropped) survives reconcile while the create's own tree lock is still held; only once that lock releases does the orphaned row get scrapped", async () => {
    const repo = makeRepo();
    const treePath = join(repo, ".worktrees", "gamma");
    sh(`git worktree add -b on-deck/gamma ${treePath}`, repo);
    // This is exactly what create.ts's final flip (Step 6) leaves behind
    // when its saveRegistry call reports false: a real, ready worktree whose
    // registry row never advanced past "creating".
    saveRegistry(repoName, [{
      name: "gamma", path: treePath, kind: "ephemeral", state: "creating",
      branch: "on-deck/gamma", createdAt: new Date().toISOString(),
    }]);

    // createTree holds this exact lock for the whole of runCreate, including
    // its final flip's runCriticalWrite retries, so a reconcile pass that
    // lands in that window sees it locked and must leave it alone.
    const release = tryLockTree(treePath);
    expect(release).not.toBeNull();
    try {
      await reconcileRepoRegistry({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });
    } finally {
      release!();
    }
    expect(loadRegistry(repoName).some((t) => t.path === treePath)).toBe(true);

    // Lock released (the create attempt has returned ok:false and given up):
    // the row is now indistinguishable from a genuinely abandoned create, and
    // the existing sweep (unaffected by this task) scraps it for a retry.
    await reconcileRepoRegistry({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });
    expect(loadRegistry(repoName).some((t) => t.path === treePath)).toBe(false);
  });
});
