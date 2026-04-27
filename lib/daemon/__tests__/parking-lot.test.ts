import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The module reads RT_DIR at import time via daemon-config.ts, which pins to
// the user's home ~/.rt. To avoid writing into the real ~/.rt during tests we
// point HOME at a tmpdir BEFORE importing.
const tmpHome = mkdtempSync(join(tmpdir(), "rt-parking-"));
process.env.HOME = tmpHome;

const { __test__ } = await import("../parking-lot.ts");

describe("reconcileIndexMap", () => {
  const repo = "test-repo";

  afterEach(() => {
    try { rmSync(join(tmpHome, ".rt", repo), { recursive: true, force: true }); } catch { /* */ }
  });

  test("primary worktree gets index 1; later worktrees get 2,3,… in list order", () => {
    const worktrees = [
      "/repo/primary",
      "/repo/wktree-2",
      "/repo/wktree-3",
    ];
    const map = __test__.reconcileIndexMap(repo, worktrees);
    expect(map).toEqual({
      "/repo/primary":  1,
      "/repo/wktree-2": 2,
      "/repo/wktree-3": 3,
    });
  });

  test("removing a middle worktree preserves the remaining indexes", () => {
    __test__.reconcileIndexMap(repo, [
      "/repo/primary", "/repo/wktree-2", "/repo/wktree-3", "/repo/wktree-4",
    ]);
    // wktree-3 is gone; wktree-4 should still have its original 4
    const map = __test__.reconcileIndexMap(repo, [
      "/repo/primary", "/repo/wktree-2", "/repo/wktree-4",
    ]);
    expect(map["/repo/primary"]).toBe(1);
    expect(map["/repo/wktree-2"]).toBe(2);
    expect(map["/repo/wktree-4"]).toBe(4);
  });

  test("new worktree claims the lowest unused positive integer", () => {
    __test__.reconcileIndexMap(repo, [
      "/repo/primary", "/repo/wktree-2", "/repo/wktree-3",
    ]);
    // wktree-2 removed; a new worktree-A appears — should claim 2, not 4
    const map = __test__.reconcileIndexMap(repo, [
      "/repo/primary", "/repo/wktree-3", "/repo/wktree-A",
    ]);
    expect(map["/repo/primary"]).toBe(1);
    expect(map["/repo/wktree-3"]).toBe(3);
    expect(map["/repo/wktree-A"]).toBe(2);
  });

  test("primary keeps 1 even if listed worktrees are empty on first call then populated", () => {
    __test__.reconcileIndexMap(repo, []);
    const map = __test__.reconcileIndexMap(repo, ["/repo/primary", "/repo/wktree-2"]);
    expect(map["/repo/primary"]).toBe(1);
    expect(map["/repo/wktree-2"]).toBe(2);
  });

  test("index map persists across reconcile calls via disk", () => {
    __test__.reconcileIndexMap(repo, ["/repo/primary", "/repo/wktree-2"]);
    const loaded = __test__.loadIndexMap(repo);
    expect(loaded).toEqual({
      "/repo/primary":  1,
      "/repo/wktree-2": 2,
    });
  });

  test("pre-existing hand-edited file is respected (primary claims 1 if free)", () => {
    const dir = join(tmpHome, ".rt", repo);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    // User manually assigned wktree-9 to 9. Primary should still claim 1.
    __test__.saveIndexMap(repo, { "/repo/wktree-9": 9 });
    const map = __test__.reconcileIndexMap(repo, [
      "/repo/primary", "/repo/wktree-9", "/repo/wktree-new",
    ]);
    expect(map["/repo/primary"]).toBe(1);
    expect(map["/repo/wktree-9"]).toBe(9);
    expect(map["/repo/wktree-new"]).toBe(2);
  });
});
