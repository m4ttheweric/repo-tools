import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb } from "../../../state/index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../../../worktree/registry.ts";
import { healLegacyPoolRoots, releaseStrandedClaims, reconcileRepo, MISSING_PRUNE_PASSES } from "../reconcile.ts";
import { tryLockTree } from "../../../worktree/locks.ts";
import { markHandoffDelivered } from "../../../worktree/patch.ts";
import { legacyWorktreePoolRoot, worktreePoolRoot } from "../../../rt-paths.ts";

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

  test("holds a tree whose pool root AND root-parent are both unreadable (mount blip), never pruning it", async () => {
    // Both `dirname(path)` (the pool root) and `dirname(dirname(path))` (the
    // root's parent, the mount point) are absent: a vanished mount, not a
    // removed pool dir. The row must survive well past MISSING_PRUNE_PASSES.
    const blip: TreeRecord = {
      name: "amber",
      path: join("/rt-nonexistent-mount-xyz", "wt", "amber"),
      kind: "ephemeral",
      state: "on-deck",
      branch: "feat-amber",
      createdAt: new Date().toISOString(),
    };
    saveRegistry(repoName, [blip]);

    for (let i = 0; i < MISSING_PRUNE_PASSES + 2; i++) {
      await reconcileRepo({ repoName, repoPath: repo, emit: () => {}, log: fakeLog() });
    }

    const held = loadRegistry(repoName).find((t) => t.name === "amber");
    expect(held).toBeDefined();
    expect(held?.missCount ?? 0).toBe(0); // a held pass never accrues a miss
  });
});

describe("reconcile.ts: healLegacyPoolRoots (RT-95)", () => {
  const identity = "remote:example.com%2Facme%2Frepo";

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtheal-home-")));
    closeStateDb();
  });

  function seed(state: "on-deck" | "claimed", root: string, name: string): TreeRecord {
    return {
      name,
      path: join(root, name),
      kind: "ephemeral",
      state,
      branch: `on-deck/${name}`,
      createdAt: new Date().toISOString(),
    };
  }

  test("flips only on-deck trees under the legacy colon root to disposable", () => {
    const legacy = legacyWorktreePoolRoot(identity);
    const current = worktreePoolRoot(identity);
    const events: Array<{ type: string; data: any }> = [];
    saveRegistry(identity, [
      seed("on-deck", legacy, "fred"),
      seed("claimed", legacy, "snape"),
      seed("on-deck", current, "tonks"),
    ]);

    healLegacyPoolRoots({ repoName: identity, emit: (type, data) => events.push({ type, data }), log: fakeLog() });

    const trees = loadRegistry(identity);
    const byName = Object.fromEntries(trees.map((t) => [t.name, t]));
    expect(byName.fred!.state).toBe("disposable");
    expect(byName.fred!.disposableReason).toContain("legacy pool root");
    expect(byName.snape!.state).toBe("claimed");
    expect(byName.tonks!.state).toBe("on-deck");
    expect(events.filter((e) => e.type === "worktree:disposable").length).toBe(1);
  });

  test("second run is a no-op", () => {
    const legacy = legacyWorktreePoolRoot(identity);
    saveRegistry(identity, [seed("on-deck", legacy, "fred")]);
    healLegacyPoolRoots({ repoName: identity, emit: () => {}, log: fakeLog() });
    const events: unknown[] = [];
    healLegacyPoolRoots({ repoName: identity, emit: (t) => events.push(t), log: fakeLog() });
    expect(events.length).toBe(0);
  });

  test("colon-free identity (legacy root equals current) heals nothing", () => {
    const plain = "acme";
    saveRegistry(plain, [seed("on-deck", worktreePoolRoot(plain), "fred")]);
    healLegacyPoolRoots({ repoName: plain, emit: () => {}, log: fakeLog() });
    expect(loadRegistry(plain)[0]!.state).toBe("on-deck");
  });
});

describe("reconcile.ts: releaseStrandedClaims (RT-99)", () => {
  const identity = "remote:example.com%2Facme%2Frepo";
  let repo: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtstrand-home-")));
    closeStateDb();
    repo = makeRepo();
  });

  /** A real git worktree at the pool root, on `branch`, with a claimed row. */
  function seedTree(name: string, branch: string, handoff?: "pending" | "done"): TreeRecord {
    const path = join(worktreePoolRoot(identity), name);
    execSync(`git worktree add -b '${branch}' '${path}'`, { cwd: repo, shell: "/bin/zsh" });
    const rec: TreeRecord = {
      name,
      path,
      kind: "ephemeral",
      state: "claimed",
      branch,
      createdAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      disposal: "merge",
      ...(handoff ? { handoff } : {}),
    };
    const trees = loadRegistry(identity);
    trees.push(rec);
    saveRegistry(identity, trees);
    return rec;
  }

  test("pending claim still on its pool branch (git-verified) goes back on-deck", async () => {
    seedTree("fred", "on-deck/fred", "pending");
    await releaseStrandedClaims({ repoName: identity, emit: () => {}, log: fakeLog() });
    const rec = loadRegistry(identity)[0]!;
    expect(rec.state).toBe("on-deck");
    expect(rec.claimedAt).toBeUndefined();
    expect(rec.handoff).toBeUndefined();
  });

  test("registry says pool branch but git moved on: disposable, never back to the pool", async () => {
    const rec = seedTree("ginny", "on-deck/ginny", "pending");
    execSync("git checkout -b acme-9-work", { cwd: rec.path, shell: "/bin/zsh" });
    await releaseStrandedClaims({ repoName: identity, emit: () => {}, log: fakeLog() });
    const stored = loadRegistry(identity)[0]!;
    expect(stored.state).toBe("disposable");
    expect(stored.branch).toBe("acme-9-work");
    expect(stored.disposableReason).toContain("stranded claim");
  });

  test("pending claim on a work branch flips disposable with a stranded reason", async () => {
    const events: Array<{ type: string }> = [];
    seedTree("bill", "acme-1-work", "pending");
    await releaseStrandedClaims({ repoName: identity, emit: (type) => events.push({ type }), log: fakeLog() });
    const rec = loadRegistry(identity)[0]!;
    expect(rec.state).toBe("disposable");
    expect(rec.disposableReason).toContain("stranded claim");
    expect(events.some((e) => e.type === "worktree:disposable")).toBe(true);
  });

  test("delivered (done) and pre-marker claims are never touched", async () => {
    seedTree("neville", "acme-2-work", "done");
    seedTree("hedwig", "acme-3-work");
    await releaseStrandedClaims({ repoName: identity, emit: () => {}, log: fakeLog() });
    for (const rec of loadRegistry(identity)) expect(rec.state).toBe("claimed");
  });

  test("delivery landing mid-release wins: the row survives untouched", async () => {
    const row = seedTree("luna", "acme-5-work", "pending");
    // The release awaits git between its pending-read and its patch; simulate
    // the handler's CAS landing in that gap by delivering before the call.
    // The release's own in-callback re-check must then refuse to mutate.
    markHandoffDelivered(identity, row.path);
    await releaseStrandedClaims({ repoName: identity, emit: () => { throw new Error("must not emit"); }, log: fakeLog() });
    const stored = loadRegistry(identity)[0]!;
    expect(stored.state).toBe("claimed");
    expect(stored.handoff).toBe("done");
  });

  test("a locked pending claim is skipped (provision still in flight)", async () => {
    const row = seedTree("tonks", "acme-4-work", "pending");
    const release = tryLockTree(row.path);
    try {
      await releaseStrandedClaims({ repoName: identity, emit: () => {}, log: fakeLog() });
      expect(loadRegistry(identity)[0]!.state).toBe("claimed");
    } finally {
      release?.();
    }
  });
});
