/**
 * Port-input modal keymap.
 *
 * Digits are handled by the <input> widget directly; only enter/escape are
 * routed through this map.
 */

import { proxyWindowName } from "../../runner-store.ts";
import { daemonQuery } from "../../daemon-client.ts";
import { ensureProxy } from "../dispatch.ts";
import type { KeymapContext, KeymapHandlers } from "./types.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";

type StateUpdater = (updater: (s: RunnerUIState) => RunnerUIState) => void;

export function createPortKeymap(ctx: KeymapContext): KeymapHandlers {
  const returnToNormal = (update: StateUpdater, extra: Partial<RunnerUIState> = {}) => {
    update((s) => ({ ...s, mode: { type: "normal" }, inputValue: "", ...extra }));
    ctx.setMode("default");
  };

  return {
    enter: ({ state, update }) => {
      const mode = state.mode;
      if (mode.type !== "port-input") return;
      const port = parseInt(state.inputValue, 10);
      if (!isNaN(port) && port > 1024 && port < 65536) {
        const ephemeralConflict = state.lanes.some((l) =>
          l.entries.some((e) => e.ephemeralPort === port)
        );
        if (ephemeralConflict) {
          ctx.showToast(`port ${port} is used by a running entry — pick another`);
          returnToNormal(update);
        } else if (mode.purpose === "edit-port" && mode.laneId) {
          const oldLane = state.lanes.find((l) => l.id === mode.laneId);
          if (oldLane && !state.lanes.find((l) => l.canonicalPort === port && l.id !== mode.laneId)) {
            // Stop old proxy and start new one on the updated port
            void daemonQuery("proxy:stop", { id: proxyWindowName(mode.laneId) }).then(() => {
              const updatedLane = { ...oldLane, canonicalPort: port };
              void ensureProxy(updatedLane, ctx.initiator);
            });
            update((s) => {
              const updatedLane = { ...oldLane, canonicalPort: port };
              const next = s.lanes.map((l) => l.id === mode.laneId ? updatedLane : l);
              ctx.saveCurrent(next);
              return { ...s, lanes: next, mode: { type: "normal" }, inputValue: "" };
            });
            ctx.setMode("default");
          } else {
            ctx.showToast(`port ${port} is already used by another lane`);
            returnToNormal(update);
          }
        }
      } else {
        returnToNormal(update);
      }
    },
    escape: ({ update }) => returnToNormal(update),
  };
}
