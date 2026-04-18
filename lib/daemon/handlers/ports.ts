/**
 * Port-allocation IPC handlers.
 *
 *   port:allocate  — reserve an ephemeral port for a label
 *   port:release   — release by label or by port number
 *   port:list      — list all current allocations
 */

import type { HandlerContext, HandlerMap } from "./types.ts";

export function createPortsHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "port:allocate": async (payload) => {
      const { label } = payload as { label: string };
      if (!label) return { ok: false, error: "missing label" };
      const port = ctx.portAllocator.allocate(label);
      return { ok: true, data: { port } };
    },

    "port:release": async (payload) => {
      const { label, port } = payload as { label?: string; port?: number };
      if (label) {
        ctx.portAllocator.releaseByLabel(label);
      } else if (port !== undefined) {
        ctx.portAllocator.release(port);
      } else {
        return { ok: false, error: "missing label or port" };
      }
      return { ok: true };
    },

    "port:list": async () => {
      return { ok: true, data: ctx.portAllocator.list() };
    },
  };
}
