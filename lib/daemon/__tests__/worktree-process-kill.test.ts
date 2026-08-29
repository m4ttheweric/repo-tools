import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, expect, test } from "bun:test";
import {
  attributeCwds,
  nestedExcludes,
  safeRealpath,
  selectKillTargets,
  type KillCandidate,
} from "../worktree-process-kill.ts";

function row(pid: number, ppid: number, command: string, fullCommand: string): KillCandidate {
  return { pid, ppid, command, fullCommand };
}

test("worktree-process-kill.ts imports no sync exec", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "worktree-process-kill.ts"), "utf8");
  expect(src).not.toMatch(/from\s+["']child_process["']/);
  expect(src).not.toMatch(/\bexecSync\b/);
});

describe("selectKillTargets", () => {
  test("kills package-script chains and orphaned compilers", () => {
    const rows = [
      row(100, 1, "doppler", "/opt/homebrew/bin/doppler run -- pnpm start:lite:watch"),
      row(101, 100, "node", "/Users/x/.volta/bin/node wrap.js src/app/server-lite"),
      row(102, 1, "tsgo", "/Users/x/node_modules/.bin/tsgo --watch"),
    ];

    const targets = selectKillTargets(rows);

    expect(targets.map(t => t.pid).sort()).toEqual([100, 101, 102]);
  });

  test("keeps AI agent sessions and all their descendants", () => {
    const rows = [
      row(10, 1, "claude", "claude"),
      row(11, 10, "bash", "bash -c 'bun test'"),
      row(12, 11, "bun", "/Users/x/.bun/bin/bun test lib"),
      row(20, 1, "node", "node server.js"),
    ];

    const targets = selectKillTargets(rows);

    // claude, its shell, and the bun the shell spawned all survive;
    // the unrelated dev server does not.
    expect(targets.map(t => t.pid)).toEqual([20]);
  });

  test("recognizes AI agents launched via an interpreter", () => {
    const rows = [
      row(30, 1, "node", "/usr/local/bin/node /Users/x/.local/bin/codex"),
      row(31, 30, "rg", "rg --files"),
    ];

    const targets = selectKillTargets(rows);

    expect(targets).toEqual([]);
  });

  test("keeps shells and .app bundle processes", () => {
    const rows = [
      row(40, 1, "zsh", "/bin/zsh -il"),
      row(41, 1, "Cursor", "/Applications/Cursor.app/Contents/MacOS/Cursor"),
      row(42, 1, "node", "node dev-server.js"),
    ];

    const targets = selectKillTargets(rows);

    expect(targets.map(t => t.pid)).toEqual([42]);
  });

  test("keeps protected pids and their descendants", () => {
    const rows = [
      row(50, 1, "bun", "bun run cli.ts parking-lot park"),
      row(51, 50, "lsof", "lsof -d cwd -Fpn"),
      row(60, 1, "node", "node watcher.js"),
    ];

    const targets = selectKillTargets(rows, { protectedPids: [50] });

    expect(targets.map(t => t.pid)).toEqual([60]);
  });

  test("custom aiAgentNames extend the default protection list", () => {
    const rows = [
      row(70, 1, "my-agent", "/usr/local/bin/my-agent --serve"),
    ];

    expect(selectKillTargets(rows).map(t => t.pid)).toEqual([70]);
    expect(selectKillTargets(rows, { aiAgentNames: ["my-agent"] })).toEqual([]);
  });

  test("multiplexers, remote shells, and editors are spared", () => {
    const rows = [
      row(10, 1, "tmux", "tmux"),
      row(11, 1, "ssh", "ssh host"),
      row(12, 1, "nvim", "nvim file.ts"),
      row(13, 1, "node", "node server.js"),
    ];

    const targets = selectKillTargets(rows);

    expect(targets.map(t => t.pid)).toEqual([13]);
  });

  test("caller pid and its descendants are spared", () => {
    const rows = [
      row(100, 1, "rt", "rt worktree dispose"),
      row(101, 100, "node", "node x"),
      row(200, 1, "node", "node dev"),
    ];

    const targets = selectKillTargets(rows, { protectedPids: [100] });

    expect(targets.map(t => t.pid)).toEqual([200]);
  });
});

describe("attributeCwds", () => {
  test("keeps only cwds inside the target", () => {
    const cwdMap = new Map([
      [1, "/repo"],
      [2, "/repo/sub"],
      [3, "/repo-sibling"],
      [4, "/elsewhere"],
    ]);

    const attributed = attributeCwds("/repo", [], cwdMap);

    expect([...attributed.keys()].sort()).toEqual([1, 2]);
  });

  test("drops cwds owned by a more-specific nested exclude", () => {
    const cwdMap = new Map([
      [1, "/repo"],
      [2, "/repo/.worktrees/other"],
      [3, "/repo/.worktrees/other/src"],
      [4, "/repo/main-work"],
    ]);

    const attributed = attributeCwds("/repo", ["/repo/.worktrees/other"], cwdMap);

    expect([...attributed.keys()].sort()).toEqual([1, 4]);
  });

  test("SYMLINKED-PREFIX: target given via a symlink whose realpath differs still excludes a nested tree", () => {
    const scratch = mkdtempSync(join(tmpdir(), "rt-kill-test-"));
    const realRootRaw = join(scratch, "real-root");
    const nestedRaw = join(realRootRaw, ".worktrees", "other");
    const symlinkedHome = join(scratch, "symlinked-home");

    mkdirSync(nestedRaw, { recursive: true });
    symlinkSync(realRootRaw, symlinkedHome);

    // `scratch` itself may sit under an ambient OS symlink (macOS /var ->
    // /private/var), so resolve the raw creation paths once to get the true
    // canonical form the test compares against.
    const realRoot = safeRealpath(realRootRaw);
    const nested = safeRealpath(nestedRaw);

    // Caller passes the worktree path through the extra symlink hop;
    // safeRealpath must still land both target and exclude on the same
    // canonical prefix as the directly-resolved paths above.
    const target = safeRealpath(symlinkedHome);
    const excludes = [safeRealpath(join(symlinkedHome, ".worktrees", "other"))];
    expect(target).toBe(realRoot);
    expect(excludes[0]).toBe(nested);

    const cwdMap = new Map([
      [1, join(realRoot, "main-work")],
      [2, join(nested, "src")], // lives under the realpath'd nested tree
    ]);

    const attributed = attributeCwds(target, excludes, cwdMap);

    expect([...attributed.keys()]).toEqual([1]);
  });

  test("safeRealpath falls back to the literal path when the target doesn't exist", () => {
    const missing = "/no/such/path/rt-kill-test";
    expect(safeRealpath(missing)).toBe(missing);
  });
});

describe("nestedExcludes", () => {
  test("drops an exclude equal to the target itself", () => {
    expect(nestedExcludes("/repo", ["/repo"])).toEqual([]);
  });

  test("keeps excludes strictly nested under the target", () => {
    expect(nestedExcludes("/repo", ["/repo/sub"])).toEqual(["/repo/sub"]);
  });

  test("a target-equal exclude does not zero out attributeCwds' kill set", () => {
    const cwdMap = new Map([
      [1, "/repo"],
      [2, "/repo/sub"],
    ]);

    const excludes = nestedExcludes("/repo", ["/repo"]);
    const attributed = attributeCwds("/repo", excludes, cwdMap);

    expect([...attributed.keys()].sort()).toEqual([1, 2]);
  });
});
