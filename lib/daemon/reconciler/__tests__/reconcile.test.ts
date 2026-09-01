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

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtstrand-home-")));
    closeStateDb();
  });

  function claimedRow(name: string, branch: string, handoff?: "pending" | "done"): TreeRecord {
    return {
      name,
      path: join(worktreePoolRoot(identity), name),
      kind: "ephemeral",
      state: "claimed",
      branch,
      createdAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(),
      disposal: "merge",
      ...(handoff ? { handoff } : {}),
    };
  }

  test("pending claim still on its pool branch goes back on-deck", () => {
    saveRegistry(identity, [claimedRow("fred", "on-deck/fred", "pending")]);
    releaseStrandedClaims({ repoName: identity, emit: () => {}, log: fakeLog() });
    const rec = loadRegistry(identity)[0]!;
    expect(rec.state).toBe("on-deck");
    expect(rec.claimedAt).toBeUndefined();
    expect(rec.handoff).toBeUndefined();
  });

  test("pending claim whose branch moved flips disposable with a stranded reason", () => {
    const events: Array<{ type: string }> = [];
    saveRegistry(identity, [claimedRow("bill", "acme-1-work", "pending")]);
    releaseStrandedClaims({ repoName: identity, emit: (type) => events.push({ type }), log: fakeLog() });
    const rec = loadRegistry(identity)[0]!;
    expect(rec.state).toBe("disposable");
    expect(rec.disposableReason).toContain("stranded claim");
    expect(events.some((e) => e.type === "worktree:disposable")).toBe(true);
  });

  test("delivered (done) and pre-marker claims are never touched", () => {
    saveRegistry(identity, [claimedRow("neville", "acme-2-work", "done"), claimedRow("hedwig", "acme-3-work")]);
    releaseStrandedClaims({ repoName: identity, emit: () => {}, log: fakeLog() });
    for (const rec of loadRegistry(identity)) expect(rec.state).toBe("claimed");
  });

  test("a locked pending claim is skipped (provision still in flight)", () => {
    const row = claimedRow("tonks", "acme-4-work", "pending");
    saveRegistry(identity, [row]);
    const release = tryLockTree(row.path);
    try {
      releaseStrandedClaims({ repoName: identity, emit: () => {}, log: fakeLog() });
      expect(loadRegistry(identity)[0]!.state).toBe("claimed");
    } finally {
      release?.();
    }
  });
});
