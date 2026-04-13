/**
 * TMUX: restoreFocus + attachLoopCmd
 *
 * Low-level tmux focus and attach helpers.
 *
 * restoreFocus  — snaps tmux focus back to the runner pane after any swap/split.
 * attachLoopCmd — builds the shell command for a pane that loops on rt attach,
 *                 showing a "stopped" banner between attach attempts.
 *
 * Source: commands/runner.tsx restoreFocus / attachLoopCmd (lines 549-557)
 */

import { spawnSync } from "node:child_process";

/**
 * Sends tmux focus back to `runnerPaneId` (the pane running the dashboard).
 * Call this after any `swap-pane` or `split-window` to keep keyboard input
 * routing to the dashboard instead of the newly created/swapped pane.
 *
 * @param runnerPaneId - tmux pane ID of the dashboard (e.g. "%3").
 *                       Usually `process.env.TMUX_PANE`.
 *
 * @example
 * ```typescript
 * const runnerPaneId = process.env.TMUX_PANE ?? "";
 * spawnSync("tmux", ["swap-pane", "-s", oldPane, "-t", newPane]);
 * restoreFocus(runnerPaneId); // ← always call after swap/split
 * ```
 */
export function restoreFocus(runnerPaneId: string): void {
  if (runnerPaneId) {
    spawnSync("tmux", ["select-pane", "-t", runnerPaneId]);
  }
}

/**
 * Builds the shell loop command for a background pane that:
 *   1. Attaches to `processId` via `rt attach`
 *   2. Shows a dim "─ stopped ─" banner when the process exits
 *   3. Waits 1 second and re-attaches
 *
 * If `processId` is empty, shows a "no service" banner instead.
 *
 * @param nodePath  - Path to the Node/Bun executable (e.g. `process.execPath`)
 * @param cliPath   - Absolute path to the rt cli.ts entry point
 * @param processId - The daemon process ID to attach to (e.g. "lane-1:entry-1")
 *
 * @example
 * ```typescript
 * const cmd = attachLoopCmd(process.execPath, CLI_PATH, "lane-1:entry-1");
 * openTempPane(cmd, { cwd: worktreePath });
 * ```
 */
export function attachLoopCmd(
  nodePath: string,
  cliPath: string,
  processId: string,
): string {
  if (processId) {
    return [
      `while true; do`,
      `  ${nodePath} ${cliPath} attach ${processId} 2>&1 || true;`,
      `  printf '\\033[2m  ─ stopped ─\\033[0m\\r\\n';`,
      `  sleep 1;`,
      `done`,
    ].join(" ");
  }
  return `while true; do printf '\\033[2m  no service\\033[0m\\r\\n'; sleep 5; done`;
}
