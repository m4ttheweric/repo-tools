/**
 * Canonical-endpoint handlers. forward mode reuses ProxyManager; bounce mode
 * reuses BounceManager. Declared endpoints + active state are per-repo, local only.
 */
import type { HandlerContext, HandlerMap } from "./types.ts";
import { loadEndpoints, loadEndpointState, saveEndpointState } from "../../endpoints-config.ts";

export function endpointProxyId(repo: string, port: number): string {
  return `endpoint:${repo}:${port}`;
}

export function bounceEndpointId(repo: string, port: number): string {
  return `bounce:${repo}:${port}`;
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

    "endpoints:bounce-enable": async (payload) => {
      const { repo, port } = payload as { repo: string; port: number };
      if (!repo || !port) return { ok: false, error: "missing repo or port" };
      const dir = ctx.repoDataDirOf(repo);
      const ep = loadEndpoints(dir).find((e) => e.port === port && e.mode === "bounce");
      if (!ep) return { ok: false, error: `no bounce endpoint declared on port ${port}` };
      ctx.bounceManager.start(bounceEndpointId(repo, port), port, {
        returnParam: ep.returnParam ?? "rt_return",
        allowedOrigins: ctx.liveOriginsFor(repo),
      });
      const state = loadEndpointState(dir);
      if (!state.bounceEnabled.includes(port)) state.bounceEnabled.push(port);
      saveEndpointState(dir, state);
      return { ok: true };
    },

    "endpoints:bounce-disable": async (payload) => {
      const { repo, port } = payload as { repo: string; port: number };
      if (!repo || !port) return { ok: false, error: "missing repo or port" };
      const dir = ctx.repoDataDirOf(repo);
      ctx.bounceManager.stop(bounceEndpointId(repo, port));
      const state = loadEndpointState(dir);
      state.bounceEnabled = state.bounceEnabled.filter((p) => p !== port);
      saveEndpointState(dir, state);
      return { ok: true };
    },
  };
}
