import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findDesktopStash, getCurrentBranch, hasUncommittedChanges } from "../../git-ops.ts";

// The module reads RT_DIR at import time via daemon-config.ts, which pins to
// the user's home ~/.rt. To avoid writing into the real ~/.rt during tests we
// point HOME at a tmpdir BEFORE importing.
const tmpHome = mkdtempSync(join(tmpdir(), "rt-parking-"));
process.env.HOME = tmpHome;

const { __test__, fastForwardParkedWorktrees, isParkable, park } = await import("../parking-lot.ts");
// Imported after the HOME override for the same RT_DIR-pinning reason.
const { saveSyncConfig } = await import("../../sync-config.ts");
const { repoDataDir } = await import("../../rt-paths.ts");

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

describe("fastForwardParkedWorktrees (dirty-tree resolution)", () => {
  const repoName = "ff-test-repo";
  const GENERATED = "src/generated/schema.graphql";

  let root: string;
  let primary: string;
  let wt: string;
  let origin: string;

  /** Run git in a given worktree. */
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rt-park-ff-")));
    origin = join(root, "origin.git");
    mkdirSync(origin);
    execFileSync("git", ["init", "--bare", "-b", "master", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", origin, "primary"], { cwd: root, stdio: "pipe" });
    primary = join(root, "primary");
    git(primary, ["config", "user.email", "t@example.com"]);
    git(primary, ["config", "user.name", "Test"]);

    // The generated file ends WITHOUT a trailing newline, mirroring the real
    // schema.graphql that froze hogwarts.
    mkdirSync(join(primary, "src", "generated"), { recursive: true });
    writeFileSync(join(primary, GENERATED), "type Query {\n  id: ID!\n}");
    writeFileSync(join(primary, "README.md"), "hi\n");
    git(primary, ["add", "."]);
    git(primary, ["commit", "-m", "init"]);
    git(primary, ["push", "origin", "master"]);

    // A linked worktree parked on its slot branch.
    wt = join(root, "wt7");
    git(primary, ["worktree", "add", "-b", "parking-lot/7", wt, "HEAD"]);

    // origin/master advances by one commit so there is something to fast-forward to.
    writeFileSync(join(primary, "NEW.md"), "new\n");
    git(primary, ["add", "."]);
    git(primary, ["commit", "-m", "advance"]);
    git(primary, ["push", "origin", "master"]);
    git(primary, ["checkout", "-q", "HEAD~1"]); // keep master off the primary's HEAD

    // Declare the generated file as auto-resolvable, exactly like assured-dev's
    // sync.json does. postResolve is present to prove the sweep does NOT run it.
    saveSyncConfig(repoDataDir(repoName), {
      autoResolve: [
        { glob: [`**/generated/**`], strategy: "theirs", postResolve: ["exit 1"] },
      ],
    });
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(repoDataDir(repoName), { recursive: true, force: true }); } catch { /* */ }
  });

  function behindCount(): number {
    return parseInt(git(wt, ["rev-list", "--count", "HEAD..origin/master"]).trim(), 10);
  }

  test("fast-forwards a clean parked worktree", () => {
    expect(behindCount()).toBe(1);
    fastForwardParkedWorktrees(repoName, primary, [{ path: wt, branch: "parking-lot/7" }]);
    expect(behindCount()).toBe(0);
  });

  test("discards a whitespace-only drift on a declared generated file, then fast-forwards", () => {
    // The exact hogwarts shape: a trailing newline appended to a generated file.
    writeFileSync(join(wt, GENERATED), "type Query {\n  id: ID!\n}\n");
    expect(hasUncommittedChanges(wt)).toBe(true);

    fastForwardParkedWorktrees(repoName, primary, [{ path: wt, branch: "parking-lot/7" }]);

    expect(behindCount()).toBe(0);
    expect(hasUncommittedChanges(wt)).toBe(false);
  });

  test("stashes and restores undeclared dirty work across the fast-forward", () => {
    writeFileSync(join(wt, "sheep.toml"), "name = 'mine'\n");
    git(wt, ["add", "sheep.toml"]);

    fastForwardParkedWorktrees(repoName, primary, [{ path: wt, branch: "parking-lot/7" }]);

    expect(behindCount()).toBe(0);
    // The user's own work must survive the sweep.
    expect(existsSync(join(wt, "sheep.toml"))).toBe(true);
    expect(readFileSync(join(wt, "sheep.toml"), "utf8")).toBe("name = 'mine'\n");
  });

  test("handles the mixed case: discard the generated drift, stash/restore the rest", () => {
    writeFileSync(join(wt, GENERATED), "type Query {\n  id: ID!\n}\n");
    writeFileSync(join(wt, "sheep.toml"), "name = 'mine'\n");
    git(wt, ["add", "sheep.toml"]);

    fastForwardParkedWorktrees(repoName, primary, [{ path: wt, branch: "parking-lot/7" }]);

    expect(behindCount()).toBe(0);
    expect(existsSync(join(wt, "sheep.toml"))).toBe(true);
    // The generated drift is gone (discarded, not stashed back on top).
    expect(git(wt, ["status", "--porcelain", "--", GENERATED]).trim()).toBe("");
  });

  test("a substantive change to a declared file is stashed, never discarded", () => {
    // Not whitespace, a real edit. The declaration says "upstream wins", but a
    // background daemon must not destroy content it didn't generate.
    writeFileSync(join(wt, GENERATED), "type Query {\n  id: ID!\n  extra: String\n}");

    fastForwardParkedWorktrees(repoName, primary, [{ path: wt, branch: "parking-lot/7" }]);

    expect(behindCount()).toBe(0);
    expect(readFileSync(join(wt, GENERATED), "utf8")).toContain("extra: String");
  });

  test("leaves a diverged parked branch alone rather than forcing it", () => {
    writeFileSync(join(wt, "local.md"), "local\n");
    git(wt, ["add", "."]);
    git(wt, ["commit", "-m", "local commit"]);
    const headBefore = git(wt, ["rev-parse", "HEAD"]).trim();

    fastForwardParkedWorktrees(repoName, primary, [{ path: wt, branch: "parking-lot/7" }]);

    expect(git(wt, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  });
});
