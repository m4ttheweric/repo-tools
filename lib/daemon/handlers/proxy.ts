/**
 * Proxy-manager IPC handlers.
 *
 *   proxy:start         — bind a canonical port, forward to an ephemeral upstream
 *   proxy:stop          — stop a proxy, free its canonical port
 *   proxy:set-upstream  — swap the live upstream without dropping clients
 *   proxy:status        — per-proxy status (connections, last swap, etc.)
 *   proxy:list          — list all live proxies
 */

import type { HandlerContext, HandlerMap } from "./types.ts";

export function createProxyHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "proxy:start": async (payload) => {
      const { id, canonicalPort, upstreamPort } =
        payload as { id: string; canonicalPort: number; upstreamPort: number };
      if (!id || !canonicalPort || !upstreamPort) {
        return { ok: false, error: "missing id, canonicalPort, or upstreamPort" };
      }
      ctx.proxyManager.start(id, canonicalPort, upstreamPort);
      return { ok: true };
    },

    "proxy:stop": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      ctx.proxyManager.stop(id);
      return { ok: true };
    },

    "proxy:set-upstream": async (payload) => {
      const { id, port } = payload as { id: string; port: number };
      if (!id || !port) return { ok: false, error: "missing id or port" };
      ctx.proxyManager.setUpstream(id, port);
      return { ok: true };
    },

    "proxy:status": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: ctx.proxyManager.getStatus(id) };
    },

    "proxy:list": async () => {
      return { ok: true, data: ctx.proxyManager.list() };
    },
  };
}
