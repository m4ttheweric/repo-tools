/**
 * Shared context passed to every keymap factory.
 *
 * Each keymap module exports a `create*Keymap(ctx)` factory that closes over
 * this context. The factory returns a `KeymapHandlers` map (key → handler)
 * ready to pass to `app.keys(...)` / `app.modes(...)` in commands/runner.tsx.
 */

import type { KeyContext } from "@rezi-ui/core";
import type { RunnerUIState } from "../../../commands/runner.tsx";
import type { LaneConfig } from "../../runner-store.ts";
import type { LaneAction } from "../dispatch.ts";
import type { RunResolveResult } from "../../../commands/run.ts";

export type KeyCtx = KeyContext<RunnerUIState>;
export type KeyHandler = (ctx: KeyCtx) => void;
export type KeymapHandlers = Record<string, KeyHandler>;

export interface OpenTempPaneOpts {
  cwd?: string;
  target?: string;
  escToClose?: boolean;
}

export interface OpenPopupOpts {
  cwd?: string;
  width?: string;
  height?: string;
  title?: string;
  hint?: string;
}

export interface KeymapContext {
  // ── App surface ─────────────────────────────────────────────────────────
  /** Defensive wrapper around app.update — no-op if app isn't running. */
  safeUpdate: (updater: (s: RunnerUIState) => RunnerUIState) => void;
  /** Set the active keybinding mode ("default" / "lane-scope" / ...). */
  setMode:    (mode: string) => void;
  /** Stop the app (quit handler). */
  stopApp:    () => void;
  /** Read-only accessor for the latest committed app state. */
  getCurrentState: () => RunnerUIState | null;

  // ── Dispatch ────────────────────────────────────────────────────────────
  /**
   * Effectful wrapper around the pure `dispatch` reducer. Seeds optimistic
   * UI state, persists the mutated lanes, and refreshes lane panes — lives
   * in runner.tsx because it closes over runOnce-local state.
   */
  doDispatch: (action: LaneAction, state: RunnerUIState) => void;

  // ── UI helpers ──────────────────────────────────────────────────────────
  showToast: (msg: string, ms?: number) => void;

  // ── tmux pane / popup helpers ───────────────────────────────────────────
  openPopup:       (cmd: string, opts?: OpenPopupOpts) => void;
  openTempPane:    (cmd: string, opts?: OpenTempPaneOpts) => string | undefined;
  displayPane:     () => string | undefined;
  switchDisplay:   (laneId: string) => void;
  createBgPane:    (laneId: string, processId: string, paneTitle?: string) => string;
  initDisplayPane: (laneId: string) => void;

  // ── MR info pane (toggled with [i]) ─────────────────────────────────────
  mrPane: {
    /** Read-through; mutated by setEnabled. */
    isEnabled: () => boolean;
    setEnabled: (enabled: boolean) => void;
    show: (branch: string) => void;
    hide: () => void;
    update: (branch: string) => void;
  };

  // ── Lane / entry lifecycle ──────────────────────────────────────────────
  /** Persist + refresh in-memory currentLanes ref. */
  saveCurrent:      (lanes: LaneConfig[]) => void;
  /** Allocate port, add entry, update daemon group/proxy + tmux pane. */
  addResolvedEntry: (laneId: string, resolved: RunResolveResult) => Promise<void>;

  // ── Pure helpers ────────────────────────────────────────────────────────
  activeEntryIdx: (lane: LaneConfig | undefined) => number;
  focusedBranch:  (s: { lanes: LaneConfig[]; laneIdx: number; entryIdx: number }) => string;

  // ── Constants (embedded in spawned shell commands) ──────────────────────
  /** Shell-escaped `rt` invocation prefix for embedding inside cmd strings. */
  rtShell:  string;
  /** Raw argv prefix for direct spawnSync calls (no shell). */
  rtInvoke: readonly string[];
}
