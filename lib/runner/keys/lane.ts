/**
 * Lane-scope keymap (entered with [l]).
 *
 * Bindings: add/remove lane, edit canonical port, toggle mode, pause,
 * spread active entry to all worktrees.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  nextLaneId,
  type LaneConfig,
} from "../../runner-store.ts";
import { daemonQuery } from "../../daemon-client.ts";
import { ensureProxy } from "../dispatch.ts";
import { entryGroupForIdx } from "../components/LaneCard.tsx";
import type { KeymapContext, KeymapHandlers } from "./types.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";

type StateUpdater = (updater: (s: RunnerUIState) => RunnerUIState) => void;

export function createLaneKeymap(ctx: KeymapContext): KeymapHandlers {
  const exitScope = (update: StateUpdater) => {
    update((s) => ({ ...s, mode: { type: "normal" } }));
    ctx.setMode("default");
  };

  return {
    escape: ({ update }) => exitScope(update),

    // [a] add lane — open picker for repo + port, poll for result
    a: ({ update }) => {
      exitScope(update);
      const cur = ctx.getCurrentState();
      if (!cur || cur.knownRepos.length === 0) {
        ctx.showToast("No known repos — run rt in a repo first");
        return;
      }
      const tmpFile = join(tmpdir(), `rt-lane-${Date.now()}.json`);
      const cmd = `${ctx.rtShell} pick-lane > ${tmpFile}`;
      ctx.openPopup(cmd, { title: "add lane", width: "100", height: "20" });
      const poll = setInterval(() => {
        if (!existsSync(tmpFile)) return;
        const content = readFileSync(tmpFile, "utf8").trim();
        if (!content) return;
        clearInterval(poll);
        try {
          const { repoName, port } = JSON.parse(content) as { repoName: string; port: number };
          unlinkSync(tmpFile);
          ctx.safeUpdate((s) => {
            if (s.lanes.find((l) => l.canonicalPort === port)) {
              ctx.showToast(`port ${port} is already used by another lane`);
              return s;
            }
            const id = nextLaneId(s.lanes);
            const newLane: LaneConfig = { id, canonicalPort: port, entries: [], repoName, mode: "warm" };
            void daemonQuery("group:create", { id: newLane.id });
            void ensureProxy(newLane, ctx.initiator);
            ctx.createBgPane(newLane.id, "", `lane ${newLane.id} · ${newLane.repoName} :${newLane.canonicalPort}`);
            ctx.initDisplayPane(newLane.id);
            const next = [...s.lanes, newLane];
            ctx.saveCurrent(next);
            return { ...s, lanes: next, laneIdx: next.length - 1 };
          });
        } catch { /* ignore parse errors */ }
      }, 300);
    },

    // [r] remove selected lane
    r: ({ update }) => {
      exitScope(update);
      const s = ctx.getCurrentState();
      if (!s) return;
      const lane = s.lanes[Math.min(s.laneIdx, s.lanes.length - 1)];
      if (lane) ctx.doDispatch({ type: "remove-lane", laneId: lane.id }, s);
    },

    // [p] edit canonical port
    p: ({ update }) => {
      const cur = ctx.getCurrentState();
      if (!cur) return;
      const lane = cur.lanes[Math.min(cur.laneIdx, cur.lanes.length - 1)];
      if (!lane) { exitScope(update); return; }
      update((s) => ({
        ...s,
        mode: { type: "port-input", purpose: "edit-port", laneId: lane.id },
        inputValue: String(lane.canonicalPort),
      }));
      ctx.setMode("port-input");
    },

    // [m] toggle lane mode (warm ↔ single)
    m: ({ update }) => {
      exitScope(update);
      const s = ctx.getCurrentState();
      if (!s) return;
      const lane = s.lanes[s.laneIdx];
      if (lane) ctx.doDispatch({ type: "toggle-mode", laneId: lane.id }, s);
    },

    // [z] pause lane — stop proxy + all services, keep config intact
    z: ({ update }) => {
      exitScope(update);
      const s = ctx.getCurrentState();
      if (!s) return;
      const lane = s.lanes[Math.min(s.laneIdx, s.lanes.length - 1)];
      if (lane) ctx.doDispatch({ type: "pause-lane", laneId: lane.id }, s);
    },

    // [w] spread active entry to all worktrees
    w: ({ update }) => {
      const s = ctx.getCurrentState();
      if (!s) { exitScope(update); return; }
      const lane = s.lanes[Math.min(s.laneIdx, s.lanes.length - 1)];
      if (!lane) { exitScope(update); return; }
      const ei = Math.min(s.entryIdx, lane.entries.length - 1);
      const spreadGroup = entryGroupForIdx(lane.entries, ei);
      const spreadEntry = lane.entries[ei];
      if (spreadGroup && spreadGroup.entries.length === 1 && spreadEntry) {
        update((st) => ({ ...st, mode: { type: "confirm-spread", laneId: lane.id, entryId: spreadEntry.id } }));
        ctx.setMode("confirm-spread");
      } else {
        exitScope(update);
      }
    },
  };
}
