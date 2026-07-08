import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findDesktopStash, getCurrentBranch, hasUncommittedChanges } from "../../git-ops.ts";

// The module reads RT_DIR at import time via daemon-config.ts, which pins to
// the user's home ~/.rt. To avoid writing into the real ~/.rt during tests we
// point HOME at a tmpdir BEFORE importing.
const tmpHome = mkdtempSync(join(tmpdir(), "rt-parking-"));
process.env.HOME = tmpHome;

const { __test__, isParkable, park } = await import("../parking-lot.ts");

describe("reconcileIndexMap", () => {
  const repo = "test-repo";

  afterEach(() => {
    try { rmSync(join(tmpHome, ".rt", "repos", repo), { recursive: true, force: true }); } catch { /* */ }
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
    const dir = join(tmpHome, ".rt", "repos", repo);
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

describe("isParkable", () => {
  // Detached worktrees (e.g. herdr warm-pool entries) have no branch but still
  // get a slot index — they should be parkable so the user can claim them onto
  // their parking-lot/N branch manually.
  test("a detached worktree with an allocated slot is parkable", () => {
    expect(isParkable({ path: "/r/wt", branch: null, index: 5 })).toBe(true);
  });

  test("a worktree on a feature branch is parkable", () => {
    expect(isParkable({ path: "/r/wt", branch: "feature/x", index: 2 })).toBe(true);
  });

  test("a worktree already on its parking-lot slot is not parkable", () => {
    expect(isParkable({ path: "/r/wt", branch: "parking-lot/3", index: 3 })).toBe(false);
  });

  test("a worktree with no allocated slot is not parkable", () => {
    expect(isParkable({ path: "/r/wt", branch: null, index: 0 })).toBe(false);
  });
});

describe("park (detached worktree)", () => {
  let root: string;
  let primary: string;
  let wt: string;

  beforeEach(() => {
    // Resolve symlinks (macOS /var → /private/var) so paths match git output.
    root = realpathSync(mkdtempSync(join(tmpdir(), "rt-park-detached-")));
    const origin = join(root, "origin.git");
    mkdirSync(origin);
    execFileSync("git", ["init", "--bare", "-b", "master", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", origin, "primary"], { cwd: root, stdio: "pipe" });
    primary = join(root, "primary");
    const g = (args: string[]) => execFileSync("git", args, { cwd: primary, stdio: "pipe" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "Test"]);
    writeFileSync(join(primary, "README.md"), "hi\n");
    g(["add", "."]);
    g(["commit", "-m", "init"]);
    g(["push", "origin", "master"]);
    // A linked worktree in detached HEAD — the warm-pool shape.
    wt = join(root, "wt5");
    g(["worktree", "add", "--detach", wt, "HEAD"]);
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  test("parks a clean detached worktree onto its slot branch", () => {
    const result = park(wt, primary, null, 5);
    expect(result.ok).toBe(true);
    expect(getCurrentBranch(wt)).toBe("parking-lot/5");
  });

  test("stashes a dirty detached worktree under the slot branch, not <null>", () => {
    writeFileSync(join(wt, "scratch.txt"), "wip\n");
    const result = park(wt, primary, null, 5);
    expect(result.ok).toBe(true);
    expect(getCurrentBranch(wt)).toBe("parking-lot/5");
    expect(hasUncommittedChanges(wt)).toBe(false);
    // The stash must be recoverable by the slot branch name. The pre-fix code
    // passed sourceBranch=null straight through, labeling the stash "<null>".
    expect(findDesktopStash(wt, "parking-lot/5")).not.toBeNull();
  });

  // Spawn a long-lived process with cwd inside the worktree, orphaned to
  // ppid 1 via double-fork — the shape of a leaked dev server. A direct
  // Bun.spawn child would be a descendant of the test process, which the
  // kill logic deliberately protects.
  function spawnOrphanInWorktree(): number {
    const out = execFileSync("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], {
      cwd: wt, encoding: "utf8",
    });
    return parseInt(out.trim(), 10);
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  test("kills a workload process rooted in the worktree when killProcesses is on", async () => {
    const pid = spawnOrphanInWorktree();
    try {
      expect(isAlive(pid)).toBe(true);

      const result = park(wt, primary, null, 5, { killProcesses: true });
      expect(result.ok).toBe(true);

      // SIGTERM lands before park() returns, but give the exit a moment.
      const deadline = Date.now() + 3000;
      while (isAlive(pid) && Date.now() < deadline) {
        await Bun.sleep(50);
      }
      expect(isAlive(pid)).toBe(false);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  });

  test("leaves worktree processes alone when killProcesses is off", async () => {
    const pid = spawnOrphanInWorktree();
    try {
      const result = park(wt, primary, null, 5);
      expect(result.ok).toBe(true);

      await Bun.sleep(300);
      expect(isAlive(pid)).toBe(true);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  });
});
