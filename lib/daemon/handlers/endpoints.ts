/**
 * Canonical-endpoint handlers. forward mode reuses ProxyManager; bounce mode is
 * added in Phase 3. Declared endpoints + active state are per-repo, local only.
 */
import type { HandlerContext, HandlerMap } from "./types.ts";
import { loadEndpoints, loadEndpointState, saveEndpointState } from "../../endpoints-config.ts";

export function endpointProxyId(repo: string, port: number): string {
  return `endpoint:${repo}:${port}`;
}

export function createEndpointHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "endpoints:list": async (payload) => {
      const { repo } = payload as { repo: string };
      if (!repo) return { ok: false, error: "missing repo" };
      const dir = ctx.repoDataDirOf(repo);
      return { ok: true, data: { endpoints: loadEndpoints(dir), state: loadEndpointState(dir) } };
    },

    "endpoints:map": async (payload) => {
      const { repo, port, processId, upstreamPort } =
        payload as { repo: string; port: number; processId: string; upstreamPort: number };
      if (!repo || !port || !processId || !upstreamPort) return { ok: false, error: "missing repo, port, processId, or upstreamPort" };
      const dir = ctx.repoDataDirOf(repo);
      const ep = loadEndpoints(dir).find((e) => e.port === port && e.mode === "forward");
      if (!ep) return { ok: false, error: `no forward endpoint declared on port ${port}` };

      ctx.proxyManager.start(endpointProxyId(repo, port), port, upstreamPort, `endpoint:${repo}`);
      const state = loadEndpointState(dir);
      state.forward[String(port)] = processId;
      saveEndpointState(dir, state);
      return { ok: true };
    },

    "endpoints:unmap": async (payload) => {
      const { repo, port } = payload as { repo: string; port: number };
      if (!repo || !port) return { ok: false, error: "missing repo or port" };
      const dir = ctx.repoDataDirOf(repo);
      ctx.proxyManager.stop(endpointProxyId(repo, port));
      const state = loadEndpointState(dir);
      delete state.forward[String(port)];
      saveEndpointState(dir, state);
      return { ok: true };
    },
  };
}
