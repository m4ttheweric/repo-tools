/**
 * Cloudflare tunnel IPC handlers.
 *
 *   tunnel:apply              — reconcile cloudflared state with the supplied lanes
 *   tunnel:status             — running/stopped + active hostnames
 *   tunnel:stop               — tear down cloudflared for a board
 */

import type { HandlerContext, HandlerMap } from "./types.ts";
import type { LaneConfig } from "../../runner-store.ts";

export function createTunnelHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "tunnel:apply": async (payload) => {
      const { boardName, lanes } = payload as { boardName?: string; lanes?: LaneConfig[] };
      if (!boardName) return { ok: false, error: "missing boardName" };
      if (!Array.isArray(lanes)) return { ok: false, error: "missing lanes array" };
      try {
        await ctx.tunnelManager.apply(boardName, lanes);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

    "tunnel:status": async (payload) => {
      const { boardName } = payload as { boardName?: string };
      if (!boardName) return { ok: false, error: "missing boardName" };
      return { ok: true, data: ctx.tunnelManager.status(boardName) };
    },

    "tunnel:stop": async (payload) => {
      const { boardName } = payload as { boardName?: string };
      if (!boardName) return { ok: false, error: "missing boardName" };
      try {
        await ctx.tunnelManager.stop(boardName);
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    },

  };
}
