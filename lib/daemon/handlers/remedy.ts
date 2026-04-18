/**
 * Remedy-engine IPC handlers.
 *
 *   remedy:set    — register rules for a process id; subscribe immediately
 *                   if the process is already running
 *   remedy:clear  — unregister rules for a process id
 *   remedy:drain  — drain (splice) the UI-facing event ring buffer
 */

import type { HandlerContext, HandlerMap } from "./types.ts";

export function createRemedyHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "remedy:set": async (payload) => {
      const { id, remedies, cwd, cmd } =
        payload as { id: string; remedies: any[]; cwd: string; cmd?: string };
      if (!id || !Array.isArray(remedies) || !cwd) {
        return { ok: false, error: "missing id, remedies, or cwd" };
      }
      ctx.remedyEngine.register(id, remedies, cwd, cmd ?? "");
      if (ctx.stateStore.getState(id) === "running") {
        ctx.remedyEngine.onSpawn(id, cwd, cmd);
      }
      return { ok: true };
    },

    "remedy:clear": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      ctx.remedyEngine.unregister(id);
      return { ok: true };
    },

    "remedy:drain": async () => {
      const events = ctx.remedyEvents.splice(0);
      return { ok: true, data: events };
    },
  };
}
