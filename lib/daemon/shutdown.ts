/**
 * Shutdown sequence — tears down servers, managed processes, watchers, and
 * runtime files in an order that beats launchd's 5s ExitTimeOut.
 */

import { existsSync, unlinkSync } from "fs";
import type { Server } from "bun";
import type { Logger } from "pino";
import { DAEMON_SOCK_PATH, DAEMON_PID_PATH } from "../daemon-config.ts";
import { clearWsClients } from "./api-server.ts";
import { disposeFreshness } from "./freshness.ts";
import { stopDiscussionsPoller } from "./discussions-poller.ts";
import type { HooksGuard } from "./hooks-guard.ts";
import { recordCleanExit } from "./supervision-state.ts";

export interface ShutdownDeps {
  /** Mutable holder — daemon.ts assigns the servers after boot. */
  servers: { socket?: Server<any>; api?: Server<any> };
  hooksGuard: HooksGuard;
  log: Logger;
}

export function createCleanup(deps: ShutdownDeps): () => void {
  const { servers, hooksGuard, log } = deps;

  return function cleanup(): void {
    // Stop accepting new traffic first, and force-close all in-flight
    // connections (including the WebSocket broadcast set). Without this, Bun
    // keeps the event loop alive draining sockets and launchd's 5s ExitTimeOut
    // (ProcessType=Interactive default) escalates SIGTERM → SIGKILL before
    // "daemon stopped" can be written.
    try { servers.socket?.stop(true); } catch { /* */ }
    try { servers.api?.stop(true); } catch { /* */ }
    clearWsClients();

    try { disposeFreshness(); } catch { /* */ }
    try { stopDiscussionsPoller(); } catch { /* */ }
    try { hooksGuard.closeAll(); } catch { /* */ }

    // RT-48: no cache flush here any more. The branch cache is written
    // through at every mutation site (lib/state/branch-cache.ts), so there
    // is nothing dirty in memory to race launchd's 5s ExitTimeOut.

    // Remove runtime files
    for (const path of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* */ }
    }

    log.info("daemon stopped");
  };
}

export interface GracefulExitDeps {
  cleanup: () => void;
  flushLogs: () => void;
  log: Logger;
  /** True once the `shutdown` verb has claimed this exit as intentional. */
  wasVerbShutdown: () => boolean;
  exit: (code?: number) => void;
  recordCleanExit: (kind: "shutdown" | "signal", code: number) => void;
}

/**
 * Graceful shutdown on all termination signals. SIGHUP is sent when the
 * parent process exits (e.g. launchd session ends, or a tray-spawned daemon's
 * parent tray is killed).
 *
 * launchd's KeepAlive.SuccessfulExit=false only respawns on a non-zero exit,
 * so the code here must distinguish the intentional `shutdown` verb (exit 0,
 * stay down) from a bare external signal — pkill, memory pressure, a stray
 * script (exit 1, launchd respawns). The sanctioned stop path
 * (SMAppService.unregister) doesn't go through this signal path at all, so
 * exiting non-zero on a bare signal never fights an intended stop.
 */
export function makeGracefulExit(deps: GracefulExitDeps): (signal: NodeJS.Signals) => void {
  return (signal: NodeJS.Signals) => {
    deps.log.info({ signal }, "received signal; shutting down");
    deps.cleanup();
    deps.flushLogs();
    if (deps.wasVerbShutdown()) {
      deps.recordCleanExit("shutdown", 0);
      deps.exit(0);
    } else {
      deps.recordCleanExit("signal", 1);
      deps.exit(1);
    }
  };
}

export function installSignalHandlers(opts: {
  cleanup: () => void;
  flushLogs: () => void;
  log: Logger;
  wasVerbShutdown: () => boolean;
}): void {
  const gracefulExit = makeGracefulExit({ ...opts, exit: process.exit, recordCleanExit });
  process.on("SIGTERM", () => gracefulExit("SIGTERM"));
  process.on("SIGINT",  () => gracefulExit("SIGINT"));
  process.on("SIGHUP",  () => gracefulExit("SIGHUP"));
}
