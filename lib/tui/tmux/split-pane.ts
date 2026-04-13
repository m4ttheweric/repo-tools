/**
 * TMUX: createSplitPaneManager
 *
 * Manages the split-pane layout used by dashboards with a "display panel":
 *   - A background tmux window holds one pane per item (lane / worktree / etc.)
 *   - One pane at a time is swapped into the right-side "display slot"
 *   - Navigation (j/k) triggers switchDisplay() to swap which pane is visible
 *
 * Architecture:
 *   ┌──────────────────┬─────────────────────────────────┐
 *   │  Dashboard       │  Display slot (one pane, live)  │
 *   │  (runner pane)   │  ← swap-pane swaps this content │
 *   └──────────────────┴─────────────────────────────────┘
 *   [bg window: hidden panes for each item, parked here between navigations]
 *
 * Source: commands/runner.tsx pane management (lines 436-684)
 *
 * Usage:
 *   const panes = createSplitPaneManager({ runnerPaneId: process.env.TMUX_PANE ?? "" });
 *
 *   // For each item, create a background pane:
 *   for (const lane of lanes) {
 *     panes.createBgPane(lane.id, processId, `lane ${lane.id} · :${lane.canonicalPort}`);
 *   }
 *
 *   // Initialize the display slot with the first item:
 *   panes.initDisplayPane(lanes[0].id);
 *
 *   // On navigation (j/k):
 *   panes.switchDisplay(newItemId);
 *
 *   // On cleanup (app stop):
 *   panes.cleanup();
 */

import { spawnSync } from "node:child_process";
import { restoreFocus } from "./focus.ts";

export interface SplitPaneManagerOptions {
  /** The tmux pane ID of the dashboard itself (e.g. `process.env.TMUX_PANE`). */
  runnerPaneId: string;
  /** The command to run in each background pane. */
  paneCommand: (itemId: string) => string;
  /** Optional: base name for the background window (default: "rt-bg-<pid>"). */
  bgWindowName?: string;
}

export interface SplitPaneManager {
  /**
   * Create a background pane for `itemId` running `cmd`.
   * The pane is parked in the background window, not yet displayed.
   *
   * @param itemId    - Unique ID for this item (used as map key).
   * @param cmd       - Shell command to run in the pane.
   * @param paneTitle - Title shown in the tmux pane border.
   * @returns The tmux pane ID.
   */
  createBgPane(itemId: string, cmd: string, paneTitle?: string): string;

  /**
   * Create the right-side display split (once) and swap the given item's pane into it.
   * No-op if the display has already been initialised — use switchDisplay() instead.
   */
  initDisplayPane(itemId: string): void;

  /**
   * Swap a different item's pane into the display slot.
   * No-op if `newItemId` is already displayed or has no pane.
   * Call this from j/k navigation handlers.
   */
  switchDisplay(newItemId: string): void;

  /**
   * Replace an item's background pane with a new one running a different command.
   * If the item is currently displayed, the display is updated atomically.
   */
  refreshPane(itemId: string, newCmd: string): void;

  /**
   * Kill a specific item's pane and remove it from tracking.
   * If it was the displayed pane, the display slot becomes empty.
   */
  killPane(itemId: string): void;

  /**
   * Returns the tmux pane ID currently in the display slot, if any.
   * Useful as the `target` argument for openTempPane().
   */
  displayPaneId(): string | undefined;

  /**
   * Kill all background panes and destroy the background window.
   * Call this from the app's cleanup / exit handler.
   */
  cleanup(): void;
}

export function createSplitPaneManager(opts: SplitPaneManagerOptions): SplitPaneManager {
  const { runnerPaneId } = opts;
  const bgWindowName = opts.bgWindowName ?? `rt-bg-${process.pid}`;

  const lanePanes    = new Map<string, string>(); // itemId → tmux pane ID
  let displayedId    = "";                         // itemId whose pane is in the display slot
  let bgWindowExists = false;

  function ensureBgWindow(): void {
    if (bgWindowExists) return;
    spawnSync("tmux", ["new-window", "-d", "-n", bgWindowName, "sleep infinity"]);
    bgWindowExists = true;
  }

  function createBgPane(itemId: string, cmd: string, paneTitle?: string): string {
    ensureBgWindow();
    const result = spawnSync("tmux", [
      "split-window", "-t", bgWindowName, "-d", "-P", "-F", "#{pane_id}", cmd,
    ], { encoding: "utf8" });
    const paneId = result.stdout?.trim() ?? "";
    lanePanes.set(itemId, paneId);
    if (paneTitle && paneId) {
      spawnSync("tmux", ["select-pane", "-t", paneId, "-T", paneTitle]);
    }
    return paneId;
  }

  function initDisplayPane(itemId: string): void {
    if (displayedId !== "") {
      switchDisplay(itemId);
      return;
    }
    const lanePaneId = lanePanes.get(itemId);
    if (!lanePaneId) return;

    // Create a placeholder right-pane in the runner window, keep focus on runner
    const tmp = spawnSync("tmux", [
      "split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "sleep infinity",
    ], { encoding: "utf8" }).stdout?.trim();
    if (!tmp) return;

    // Swap lane pane into display; placeholder goes to bg window
    spawnSync("tmux", ["swap-pane", "-s", lanePaneId, "-t", tmp]);
    displayedId = itemId;
    restoreFocus(runnerPaneId);
  }

  function switchDisplay(newItemId: string): void {
    if (newItemId === displayedId) return;
    if (!lanePanes.has(newItemId)) return;
    if (displayedId === "") return;

    const currentPaneId = lanePanes.get(displayedId)!;
    const newPaneId     = lanePanes.get(newItemId)!;
    spawnSync("tmux", ["swap-pane", "-s", currentPaneId, "-t", newPaneId]);
    displayedId = newItemId;
    restoreFocus(runnerPaneId);
  }

  function refreshPane(itemId: string, newCmd: string): void {
    const oldPaneId  = lanePanes.get(itemId);
    if (!oldPaneId) return;
    const wasDisplayed = displayedId === itemId;

    const newPaneId = createBgPane(itemId, newCmd);
    if (wasDisplayed && newPaneId) {
      spawnSync("tmux", ["swap-pane", "-s", oldPaneId, "-t", newPaneId]);
      restoreFocus(runnerPaneId);
    }
    spawnSync("tmux", ["kill-pane", "-t", oldPaneId]);
  }

  function killPane(itemId: string): void {
    const paneId = lanePanes.get(itemId);
    if (!paneId) return;
    if (displayedId === itemId) displayedId = "";
    spawnSync("tmux", ["kill-pane", "-t", paneId]);
    lanePanes.delete(itemId);
  }

  function displayPaneId(): string | undefined {
    return displayedId ? lanePanes.get(displayedId) : undefined;
  }

  function cleanup(): void {
    for (const paneId of lanePanes.values()) {
      try { spawnSync("tmux", ["kill-pane", "-t", paneId]); } catch { /* ignore */ }
    }
    lanePanes.clear();
    if (bgWindowExists) {
      try { spawnSync("tmux", ["kill-window", "-t", bgWindowName]); } catch { /* ignore */ }
    }
  }

  return {
    createBgPane,
    initDisplayPane,
    switchDisplay,
    refreshPane,
    killPane,
    displayPaneId,
    cleanup,
  };
}
