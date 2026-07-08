import { describe, expect, test } from "bun:test";
import { selectKillTargets, type KillCandidate } from "../worktree-process-kill.ts";

function row(pid: number, ppid: number, command: string, fullCommand: string): KillCandidate {
  return { pid, ppid, command, fullCommand };
}

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
});
