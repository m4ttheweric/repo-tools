/**
 * Default / normal-mode keymap (navigation + quick-action globals).
 */

import { entryWindowName } from "../../runner-store.ts";
import type { LaneAction } from "../dispatch.ts";
import type { KeymapContext, KeymapHandlers } from "./types.ts";

export function createNormalKeymap(ctx: KeymapContext): KeymapHandlers {
  const enterScope = (scopeMode: "lane-scope" | "process-scope" | "open-scope")
    : KeymapHandlers[string] =>
    ({ update }) => {
      update((s) => ({ ...s, mode: { type: scopeMode } }));
      ctx.setMode(scopeMode);
    };

  return {
    q: () => { ctx.stopApp(); },

    j: ({ state, update }) => {
      const newLi = Math.min(state.laneIdx + 1, state.lanes.length - 1);
      const newEi = ctx.activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      ctx.switchDisplay(state.lanes[newLi]?.id ?? "");
      ctx.mrPane.update(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },
    k: ({ state, update }) => {
      const newLi = Math.max(0, state.laneIdx - 1);
      const newEi = ctx.activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      ctx.switchDisplay(state.lanes[newLi]?.id ?? "");
      ctx.mrPane.update(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },
    down: ({ state, update }) => {
      const newLi = Math.min(state.laneIdx + 1, state.lanes.length - 1);
      const newEi = ctx.activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      ctx.switchDisplay(state.lanes[newLi]?.id ?? "");
      ctx.mrPane.update(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },
    up: ({ state, update }) => {
      const newLi = Math.max(0, state.laneIdx - 1);
      const newEi = ctx.activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      ctx.switchDisplay(state.lanes[newLi]?.id ?? "");
      ctx.mrPane.update(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },

    right: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      const len = lane?.entries.length ?? 1;
      const newEi = (state.entryIdx + 1) % len;
      update((s) => ({ ...s, entryIdx: newEi }));
      ctx.mrPane.update(lane?.entries[newEi]?.branch ?? "");
    },
    left: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      const len = lane?.entries.length ?? 1;
      const newEi = (state.entryIdx - 1 + len) % len;
      update((s) => ({ ...s, entryIdx: newEi }));
      ctx.mrPane.update(lane?.entries[newEi]?.branch ?? "");
    },

    // Scope gates — enter sub-mode to show scoped key hints
    l: enterScope("lane-scope"),
    p: enterScope("process-scope"),
    o: enterScope("open-scope"),

    // Quick-access globals (no scope needed — most common operations)
    s: ({ state }) => {
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const ei = Math.min(state.entryIdx, lane.entries.length - 1);
      const entry = lane.entries[ei];
      if (!entry) return;
      const win = entryWindowName(lane.id, entry.id);
      const st = state.entryStates.get(win) ?? "stopped";
      if (st === "starting" || st === "stopping") return;
      const action: LaneAction =
        st === "stopped" ? { type: "spawn",   laneId: lane.id, entryId: entry.id } :
        st === "crashed" ? { type: "respawn", laneId: lane.id, entryId: entry.id } :
        (st === "running" && lane.activeEntryId === entry.id)
          ? { type: "restart",  laneId: lane.id, entryId: entry.id } :
            { type: "activate", laneId: lane.id, entryId: entry.id };
      ctx.doDispatch(action, state);
    },
    enter: ({ state }) => {
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const ei = Math.min(state.entryIdx, lane.entries.length - 1);
      const entry = lane.entries[ei];
      if (!entry) return;
      if (lane.activeEntryId === entry.id) return;
      ctx.doDispatch({ type: "activate", laneId: lane.id, entryId: entry.id }, state);
    },

    // [x] stop focused entry — global shortcut (no scope needed)
    x: ({ state }) => {
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (entry) ctx.doDispatch({ type: "stop", laneId: lane.id, entryId: entry.id }, state);
    },

    // [t] open shell at entry's working directory (global shortcut)
    t: ({ state }) => {
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      ctx.openTempPane(process.env.SHELL ?? "zsh", { cwd: entry.targetDir, target: ctx.displayPane(), escToClose: true });
    },
  };
}
