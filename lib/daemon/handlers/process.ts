/**
 * Process-lifecycle IPC handlers.
 *
 * Low-level primitives:
 *   process:spawn       process:kill       process:respawn    process:remove
 *
 * Composite lifecycle (bundles spawn/kill + group activate + proxy upstream swap
 * into a single atomic round-trip so the runner never has to orchestrate
 * multi-step sequences that can race or leave state machines inconsistent):
 *   process:start       process:stop       process:restart
 *
 * Introspection:
 *   process:list   process:state   process:states   process:logs   process:attach-info
 *
 * Suspend/resume (SIGSTOP/SIGCONT for warm lanes):
 *   process:suspend     process:resume
 */

import { existsSync } from "fs";
import type { HandlerContext, HandlerMap } from "./types.ts";
import { proxyWindowName } from "../../runner-store.ts";
import { diag } from "../../diag-log.ts";

export function createProcessHandlers(ctx: HandlerContext): HandlerMap {
  return {
    // ── Low-level primitives ────────────────────────────────────────────────

    "process:spawn": async (payload) => {
      const { id, cmd, cwd, env } =
        payload as { id: string; cmd: string; cwd: string; env?: Record<string, string> };
      if (!id || !cmd || !cwd) return { ok: false, error: "missing id, cmd, or cwd" };
      await ctx.processManager.spawn(id, cmd, { cwd, env });
      ctx.remedyEngine.onSpawn(id, cwd, cmd);
      return { ok: true };
    },

    "process:kill": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await ctx.processManager.kill(id);
      return { ok: true };
    },

    "process:respawn": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await ctx.processManager.respawn(id);
      // Pass stored cwd/cmd so globals-only matches survive respawn even if
      // per-entry register() was never called for this id.
      const cfg = ctx.processManager.getSpawnConfig(id);
      ctx.remedyEngine.onSpawn(id, cfg?.cwd, cfg?.cmd);
      return { ok: true };
    },

    /**
     * Tear down all daemon-side state for a process id. Used when a runner
     * entry is deleted. Before this existed, spawn configs, state entries,
     * log buffers, and remedy subscriptions accumulated for the daemon's
     * entire lifetime because no command cleared them.
     *
     * Caller is responsible for killing the process first (or accepting that
     * it will be orphaned); this handler is pure bookkeeping.
     */
    "process:remove": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      try { ctx.remedyEngine.unregister(id); } catch { /* */ }
      try { ctx.attachServer.close(id); }    catch { /* */ }
      try { ctx.logBuffer.remove(id); }      catch { /* */ }
      try { ctx.processManager.remove(id); } catch { /* */ }
      try { ctx.stateStore.remove(id); }     catch { /* */ }
      return { ok: true };
    },

    // ── Composite lifecycle ─────────────────────────────────────────────────

    "process:start": async (payload) => {
      const { id, cmd, cwd, env, groupId, canonicalPort, mode } = payload as {
        id: string; cmd: string; cwd: string;
        env?: Record<string, string>;
        groupId?: string;
        canonicalPort?: number;
        mode?: "warm" | "single";
      };
      if (!id || !cmd || !cwd) return { ok: false, error: "missing id, cmd, or cwd" };

      diag("process.start.begin", id, { groupId, canonicalPort, mode });

      // 1. Spawn (sets state "starting" → "running")
      await ctx.processManager.spawn(id, cmd, { cwd, env });

      // 2. Group activate — suspends/kills other members
      if (groupId) {
        try { await ctx.exclusiveGroup.activate(groupId, id, mode ?? "warm"); }
        catch { /* group may not exist yet */ }
      }

      // 3. Point proxy upstream to the new ephemeral port
      const ephemeralPort = Number(env?.PORT ?? 0);
      if (groupId && canonicalPort && ephemeralPort) {
        const proxyId = proxyWindowName(groupId);
        try {
          ctx.proxyManager.setUpstream(proxyId, ephemeralPort);
        } catch (err) {
          // No proxy exists yet — create it now so the process is reachable via
          // the canonical port. This is the recovery path when a proxy has been
          // lost but the runner still expects it to exist.
          diag("process.start.proxy.missing", id, { proxyId, canonicalPort, ephemeralPort, err: String(err) });
          try {
            ctx.proxyManager.start(proxyId, canonicalPort, ephemeralPort);
            diag("process.start.proxy.recreated", id, { proxyId, canonicalPort, ephemeralPort });
          } catch (err2) {
            diag("process.start.proxy.recreate.failed", id, { proxyId, err: String(err2) });
          }
        }
      }

      ctx.remedyEngine.onSpawn(id, cwd, cmd);
      diag("process.start.end", id, { ephemeralPort });
      return { ok: true, data: { ephemeralPort } };
    },

    "process:stop": async (payload) => {
      const { id, stopProxy, groupId } =
        payload as { id: string; stopProxy?: boolean; groupId?: string };
      if (!id) return { ok: false, error: "missing id" };

      await ctx.processManager.kill(id);

      if (stopProxy && groupId) {
        ctx.proxyManager.stop(proxyWindowName(groupId));
      }
      return { ok: true };
    },

    "process:restart": async (payload) => {
      const { id, cmd, cwd, env, groupId, canonicalPort, mode } = payload as {
        id: string; cmd: string; cwd: string;
        env?: Record<string, string>;
        groupId?: string;
        canonicalPort?: number;
        mode?: "warm" | "single";
      };
      if (!id || !cmd || !cwd) return { ok: false, error: "missing id, cmd, or cwd" };

      // 1. Kill current process and AWAIT its death — no cross-process race
      //    possible because both kill and spawn run sequentially in this
      //    daemon event loop.
      await ctx.processManager.kill(id);

      // 2. Spawn fresh (sets state "starting" → "running")
      await ctx.processManager.spawn(id, cmd, { cwd, env });

      // 3. Group activate
      if (groupId) {
        try { await ctx.exclusiveGroup.activate(groupId, id, mode ?? "warm"); }
        catch { /* group may not exist yet */ }
      }

      // 4. Point proxy upstream to the new ephemeral port
      const ephemeralPort = Number(env?.PORT ?? 0);
      if (groupId && canonicalPort && ephemeralPort) {
        ctx.proxyManager.setUpstream(proxyWindowName(groupId), ephemeralPort);
      }

      ctx.remedyEngine.onSpawn(id, cwd, cmd);
      return { ok: true, data: { ephemeralPort } };
    },

    // ── Introspection ───────────────────────────────────────────────────────

    "process:list":   async () => ({ ok: true, data: ctx.processManager.list() }),
    "process:states": async () => ({ ok: true, data: ctx.stateStore.getAll() }),

    "process:state": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: ctx.stateStore.getState(id) };
    },

    "process:logs": async (payload) => {
      const { id, n } = payload as { id: string; n?: number };
      if (!id) return { ok: false, error: "missing id" };
      return { ok: true, data: ctx.logBuffer.getLastLines(id, n) };
    },

    "process:attach-info": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      const socketPath = ctx.attachServer.socketPath(id);
      const hasSocket  = existsSync(socketPath);
      const state      = ctx.stateStore.getState(id) ?? "stopped";
      return { ok: true, data: { socketPath: hasSocket ? socketPath : null, state } };
    },

    // ── Suspend/resume ──────────────────────────────────────────────────────

    "process:suspend": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await ctx.suspendManager.suspend(id);
      return { ok: true };
    },

    "process:resume": async (payload) => {
      const { id } = payload as { id: string };
      if (!id) return { ok: false, error: "missing id" };
      await ctx.suspendManager.resume(id);
      return { ok: true };
    },
  };
}
