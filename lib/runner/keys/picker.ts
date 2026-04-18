/**
 * Entry-picker modal keymap.
 *
 * Used when the user hits [p → r] to pick which entry to remove.
 */

import type { KeymapContext, KeymapHandlers } from "./types.ts";

export function createPickerKeymap(ctx: KeymapContext): KeymapHandlers {
  return {
    j: ({ state, update }) => {
      const mode = state.mode;
      if (mode.type !== "entry-picker") return;
      const lane = state.lanes.find((l) => l.id === mode.laneId);
      if (!lane) return;
      update((s) => s.mode.type === "entry-picker"
        ? { ...s, mode: { ...s.mode, idx: Math.min(s.mode.idx + 1, lane.entries.length - 1) } }
        : s
      );
    },
    k: ({ state, update }) => {
      if (state.mode.type !== "entry-picker") return;
      update((s) => s.mode.type === "entry-picker"
        ? { ...s, mode: { ...s.mode, idx: Math.max(0, s.mode.idx - 1) } }
        : s
      );
    },
    down: ({ state, update }) => {
      const mode = state.mode;
      if (mode.type !== "entry-picker") return;
      const lane = state.lanes.find((l) => l.id === mode.laneId);
      if (!lane) return;
      update((s) => s.mode.type === "entry-picker"
        ? { ...s, mode: { ...s.mode, idx: Math.min(s.mode.idx + 1, lane.entries.length - 1) } }
        : s
      );
    },
    up: ({ state, update }) => {
      if (state.mode.type !== "entry-picker") return;
      update((s) => s.mode.type === "entry-picker"
        ? { ...s, mode: { ...s.mode, idx: Math.max(0, s.mode.idx - 1) } }
        : s
      );
    },
    enter: ({ state, update }) => {
      const mode = state.mode;
      if (mode.type !== "entry-picker") return;
      const lane = state.lanes.find((l) => l.id === mode.laneId);
      if (!lane) { update((s) => ({ ...s, mode: { type: "normal" } })); ctx.setMode("default"); return; }
      const entry = lane.entries[mode.idx];
      if (entry) {
        ctx.doDispatch({ type: "remove-entry", laneId: lane.id, entryId: entry.id }, state);
      }
      update((s) => ({ ...s, mode: { type: "normal" } }));
      ctx.setMode("default");
    },
    escape: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); ctx.setMode("default"); },
  };
}
