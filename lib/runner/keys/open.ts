/**
 * Open-scope keymap (entered with [o]).
 *
 * Bindings: branch picker, open editor, open browser, open shell,
 * run script, toggle MR info pane.
 */

import { spawnSync } from "node:child_process";
import { willPrompt } from "../../../commands/code.ts";
import type { KeymapContext, KeymapHandlers } from "./types.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";

type StateUpdater = (updater: (s: RunnerUIState) => RunnerUIState) => void;

export function createOpenKeymap(ctx: KeymapContext): KeymapHandlers {
  const exitScope = (update: StateUpdater) => {
    update((s) => ({ ...s, mode: { type: "normal" } }));
    ctx.setMode("default");
  };

  return {
    escape: ({ update }) => exitScope(update),

    // [b] branch picker
    b: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      ctx.openPopup(`${ctx.rtShell} branch`, { cwd: entry.worktree, title: "rt branch", width: "100", height: "20" });
    },

    // [c] open worktree in editor
    c: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      if (willPrompt(entry.worktree)) {
        ctx.openPopup(`${ctx.rtShell} code`, { cwd: entry.worktree, title: "rt code", width: "100", height: "20" });
      } else {
        spawnSync(ctx.rtInvoke[0]!, [...ctx.rtInvoke.slice(1), "code"], {
          cwd: entry.worktree, stdio: "pipe", env: { ...process.env, RT_BATCH: "1" },
        });
        ctx.showToast(`↗ opened ${entry.worktree.split("/").pop()} in editor`);
      }
    },

    // [w] open canonical port in browser (web)
    w: ({ update }) => {
      exitScope(update);
      const cur = ctx.getCurrentState();
      if (!cur) return;
      const lane = cur.lanes[Math.min(cur.laneIdx, cur.lanes.length - 1)];
      if (!lane?.canonicalPort) return;
      try { spawnSync("open", [`http://localhost:${lane.canonicalPort}`]); } catch { /* ignore */ }
    },

    // [t] open shell at entry's working directory
    t: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      ctx.openTempPane(process.env.SHELL ?? "zsh", { cwd: entry.targetDir, target: ctx.displayPane(), escToClose: true });
    },

    // [r] run a one-off package script
    r: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      ctx.openPopup(`${ctx.rtShell} run`, { cwd: entry.targetDir, title: "rt run", width: "100", height: "20" });
    },

    // [e] edit command template — delegated to process-scope [e]
    e: ({ update }) => {
      exitScope(update);
      const state = ctx.getCurrentState();
      if (!state) return;
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      ctx.showToast("tip: use [p → e] to edit the command");
    },

    // [i] toggle MR/ticket info pane
    i: ({ update }) => {
      exitScope(update);
      const cur = ctx.getCurrentState();
      if (!cur) return;
      if (ctx.mrPane.isEnabled()) {
        ctx.mrPane.setEnabled(false);
        ctx.mrPane.hide();
      } else {
        ctx.mrPane.setEnabled(true);
        ctx.mrPane.show(ctx.focusedBranch(cur));
      }
    },
  };
}
