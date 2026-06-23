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
 *   process:list   process:describe   process:state   process:states
 *   process:logs   process:attach-info
 *
 * Suspend/resume (SIGSTOP/SIGCONT for warm lanes):
 *   process:suspend     process:resume
 */

import { existsSync } from "fs";
import type { HandlerContext, HandlerMap } from "./types.ts";
import { proxyWindowName } from "../../runner-store.ts";
import { diag } from "../../diag-log.ts";
import { listWorktrees } from "../../git-worktrees.ts";
import { buildProcessRecords } from "../process-records.ts";
import type { WorktreeInfo } from "../resolve-worktree.ts";
import { discoverWorktreeCommands, deriveProcessId, detectPackageManager, buildRunCommand } from "../worktree-commands.ts";
import { buildPortlessCommand, deriveAppName, portlessUrl, worktreeBranchPrefix } from "../portless.ts";

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
      try { ctx.portAllocator.releaseByLabel(id); } catch { /* */ }
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
            ctx.proxyManager.start(proxyId, canonicalPort, ephemeralPort, "daemon:recovery");
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

    /**
     * Enriched, external-consumer view: every managed process merged with its
     * live state/pid and the repo/worktree its cwd resolves to. This is the
     * shape a GUI dashboard renders; `process:list` stays lean for the CLI.
     */
    "process:describe": async () => {
      const repos = ctx.repoIndex();
      const worktrees: WorktreeInfo[] = [];
      for (const [repo, repoPath] of Object.entries(repos)) {
        for (const wt of listWorktrees(repoPath)) {
          worktrees.push({ repo, path: wt.path, branch: wt.branch });
        }
      }
      const records = buildProcessRecords(
        ctx.processManager.list(),
        (id) => ctx.stateStore.getState(id),
        (id) => ctx.stateStore.getPid(id),
        worktrees,
      );
      return { ok: true, data: records };
    },

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

    // ── Launch (self-service, no rt runner needed) ──────────────────────────

    /** List a worktree's runnable packages + scripts (monorepo-aware). */
    "worktree:commands": async (payload) => {
      const { path } = payload as { path?: string };
      if (!path) return { ok: false, error: "missing path" };
      return { ok: true, data: { packages: discoverWorktreeCommands(path) } };
    },

    /**
     * Launch in a worktree/package. Prefer `script` (run through the package
     * manager so node_modules/.bin is on PATH — running the raw script body
     * directly fails with "command not found" for local bins like turbo/vite).
     * `cmd` is a raw-command escape hatch.
     */
    "process:create": async (payload) => {
      const { cwd, cmd, script, label, portless } = payload as {
        cwd: string; cmd?: string; script?: string; label?: string; portless?: boolean;
      };
      if (!cwd || (!cmd && !script)) return { ok: false, error: "missing cwd and (cmd or script)" };
      const baseCmd = script ? buildRunCommand(detectPackageManager(cwd), script) : cmd!;
      const id = deriveProcessId(cwd, label ?? script ?? cmd!);

      // portless default: rt owns the app port (--app-port) and name (--name) so
      // it knows the upstream port and can construct a stable, no-port URL.
      const wantPortless = portless !== false;
      const available = ctx.portlessAvailable();
      let runCmd = baseCmd;
      let portlessState: "on" | "off" | "unavailable" = "off";
      const env: Record<string, string> = {};
      if (wantPortless && available) {
        const port = ctx.portAllocator.allocate(id);
        const name = deriveAppName(cwd);
        const url = portlessUrl(name, worktreeBranchPrefix(cwd));
        runCmd = buildPortlessCommand(baseCmd, { appPort: port, name });
        env.PORT = String(port);
        env.PORTLESS_URL = url;
        portlessState = "on";
      } else if (wantPortless && !available) {
        portlessState = "unavailable";
      }

      await ctx.processManager.spawn(id, runCmd, { cwd, env });
      ctx.remedyEngine.onSpawn(id, cwd, runCmd);
      return { ok: true, data: { id, portless: portlessState } };
    },

    /**
     * Open an interactive terminal session: a login shell under a PTY, in the
     * given cwd. The GUI attaches bidirectionally over /ws/processes/:id/attach
     * and gets a real terminal — run anything (claude, vim, git, …). Tagged
     * kind:"terminal" so consumers render it as a session, not a dev process.
     */
    "terminal:create": async (payload) => {
      const { cwd } = payload as { cwd?: string };
      if (!cwd) return { ok: false, error: "missing cwd" };
      const shell = process.env.SHELL || "/bin/zsh";
      const base = cwd.replace(/\/+$/, "").split("/").pop() || "term";
      // Unique id per session: term:<dir>:<n>, n = max existing index + 1.
      const prefix = `term:${base}:`;
      const used = ctx.processManager.list()
        .map((p) => p.id)
        .filter((id) => id.startsWith(prefix))
        .map((id) => Number(id.slice(prefix.length)))
        .filter((n) => Number.isInteger(n));
      const id = `${prefix}${(used.length ? Math.max(...used) : 0) + 1}`;
      await ctx.processManager.spawn(id, `${shell} -il`, { cwd, kind: "terminal" });
      return { ok: true, data: { id } };
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
