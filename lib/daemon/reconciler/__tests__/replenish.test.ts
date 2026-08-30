import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb } from "../../../state/index.ts";
import { saveRegistry, type TreeRecord } from "../../../worktree/registry.ts";
import { withCreateLock, poolCounts, hasFreeDiskGb, createBackoff } from "../replenish.ts";

function onDeckEntry(path: string, overrides: Partial<TreeRecord> = {}): TreeRecord {
  return {
    name: path,
    path,
    kind: "ephemeral",
    state: "on-deck",
    branch: "feature",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("replenish.ts: withCreateLock", () => {
  test("serializes concurrent calls for the same repoPath: never two holders at once", async () => {
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

describe("replenish.ts: poolCounts", () => {
  const repoName = "acme";

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtreplenish-home-")));
    closeStateDb();
  });

  test("counts on-deck and creating entries, ready gated on nextRetryAt", () => {
    saveRegistry(repoName, [
      onDeckEntry("/t/a"),
      onDeckEntry("/t/b", { nextRetryAt: new Date(Date.now() + 60_000).toISOString() }),
      onDeckEntry("/t/c", { state: "creating" }),
      onDeckEntry("/t/claimed", { state: "claimed" }),
    ]);

    const counts = poolCounts(repoName);
    expect(counts.ready).toBe(1);
    expect(counts.totalUnclaimed).toBe(3);
    expect(counts.onDeckEntries.map((t) => t.path).sort()).toEqual(["/t/a", "/t/b"]);
  });
});

describe("replenish.ts: hasFreeDiskGb", () => {
  test("a probe failure on an unresolvable path degrades to true", async () => {
    expect(await hasFreeDiskGb("/no/such/path/at/all", 5)).toBe(true);
  });
});

describe("replenish.ts: createBackoff", () => {
  test("is the same module-scope map worktree-reconciler.ts re-exports for tests", async () => {
    const { __test__ } = await import("../../worktree-reconciler.ts");
    expect(__test__.createBackoff).toBe(createBackoff);
  });
});
