/**
 * Tunnel-scope keymap (entered with [u] from normal mode).
 *
 * t[u]nnel — toggle Cloudflare tunnel publishing for lanes.
 *
 * Bindings:
 *   [t] — toggle focused lane
 *   [a] — toggle all lanes (if any are off, turn all on; otherwise turn all off)
 *   [s] — open setup picker (pick-tunnel)
 *   [c] — copy focused lane's public URL to clipboard
 *   [esc] — leave scope
 */

import { spawnSync } from "node:child_process";
import { daemonQuery } from "../../daemon-client.ts";
import { hostnameFor, loadTunnelConfig } from "../../tunnel-config.ts";
import type { KeymapContext, KeymapHandlers } from "./types.ts";
import type { RunnerUIState } from "../../../commands/runner.tsx";
import type { LaneConfig } from "../../runner-store.ts";

type StateUpdater = (updater: (s: RunnerUIState) => RunnerUIState) => void;

/** Board name = the runner config name; passed in by runner.tsx at wire time. */
export function createTunnelKeymap(
  ctx: KeymapContext,
  opts: { boardName: string },
): KeymapHandlers {
  const exitScope = (update: StateUpdater) => {
    update((s) => ({ ...s, mode: { type: "normal" } }));
    ctx.setMode("default");
  };

  async function applyTunnels(lanes: LaneConfig[]): Promise<void> {
    const res = await daemonQuery("tunnel:apply", { boardName: opts.boardName, lanes });
    if (!res?.ok) {
      ctx.showToast(`tunnel: ${res?.error ?? "daemon unavailable"}`);
    }
  }

  function focusedLane(state: RunnerUIState): LaneConfig | undefined {
    return state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
  }

  return {
    escape: ({ update }) => exitScope(update),

    // [t] toggle focused lane
    t: ({ state, update }) => {
      const lane = focusedLane(state);
      if (!lane) { exitScope(update); return; }

      const cfg = loadTunnelConfig();
      if (!cfg && !lane.tunnel?.enabled) {
        ctx.showToast("no tunnel configured — press [u][s] to set up");
        exitScope(update);
        return;
      }

      ctx.safeUpdate((s) => {
        const next = s.lanes.map((l) =>
          l.id === lane.id ? { ...l, tunnel: { enabled: !(l.tunnel?.enabled === true) } } : l);
        ctx.saveCurrent(next);
        void applyTunnels(next);
        return { ...s, lanes: next };
      });
      const newState = !(lane.tunnel?.enabled === true);
      if (cfg) ctx.showToast(newState ? `🌐 ${hostnameFor(cfg, lane.canonicalPort)}` : `tunnel off for lane ${lane.id}`);
      exitScope(update);
    },

    // [a] toggle all
    a: ({ state, update }) => {
      const cfg = loadTunnelConfig();
      const anyOff = state.lanes.some((l) => !(l.tunnel?.enabled === true));
      const turnOn = anyOff;
      if (turnOn && !cfg) {
        ctx.showToast("no tunnel configured — press [u][s] to set up");
        exitScope(update);
        return;
      }
      ctx.safeUpdate((s) => {
        const next = s.lanes.map((l) => ({ ...l, tunnel: { enabled: turnOn } }));
        ctx.saveCurrent(next);
        void applyTunnels(next);
        return { ...s, lanes: next };
      });
      ctx.showToast(turnOn ? "all tunnels on" : "all tunnels off");
      exitScope(update);
    },

    // [s] setup picker
    s: ({ update }) => {
      const cmd = `${ctx.rtShell} pick-tunnel`;
      ctx.openPopup(cmd, { title: "tunnel setup", width: "80", height: "20" });
      exitScope(update);
    },

    // [c] copy URL
    c: ({ state, update }) => {
      const lane = focusedLane(state);
      if (!lane) { exitScope(update); return; }
      if (!(lane.tunnel?.enabled === true)) {
        ctx.showToast("lane has tunnel disabled — press [t] first");
        exitScope(update);
        return;
      }
      const cfg = loadTunnelConfig();
      if (!cfg) {
        ctx.showToast("no tunnel configured");
        exitScope(update);
        return;
      }
      const url = `https://${hostnameFor(cfg, lane.canonicalPort)}`;
      try {
        const r = spawnSync("pbcopy", { input: url });
        if (r.status !== 0) throw new Error();
        ctx.showToast(`copied ${url}`);
      } catch {
        ctx.showToast(url);
      }
      exitScope(update);
    },
  };
}
