/**
 * Shutdown sequence — tears down servers, managed processes, watchers, and
 * runtime files in an order that beats launchd's 5s ExitTimeOut.
 */

import { existsSync, unlinkSync } from "fs";
import type { Server } from "bun";
import type { Logger } from "pino";
import { DAEMON_SOCK_PATH, DAEMON_PID_PATH } from "../daemon-config.ts";
import { clearWsClients } from "./api-server.ts";
import { cleanupAllWatchers } from "./workspace-sync.ts";
import { disposeAllMRSubscriptions } from "./mr-subscriptions.ts";
import { stopDiscussionsPoller } from "./discussions-poller.ts";
import type { HooksGuard } from "./hooks-guard.ts";

export interface ShutdownDeps {
  /** Mutable holder — daemon.ts assigns the servers after boot. */
  servers: { socket?: Server<any>; api?: Server<any> };
  hooksGuard: HooksGuard;
  flushCache: () => void;
  log: Logger;
}

export function createCleanup(deps: ShutdownDeps): () => void {
  const { servers, hooksGuard, flushCache, log } = deps;

  return function cleanup(): void {
    // Stop accepting new traffic first, and force-close all in-flight
    // connections (including the WebSocket broadcast set). Without this, Bun
    // keeps the event loop alive draining sockets and launchd's 5s ExitTimeOut
    // (ProcessType=Interactive default) escalates SIGTERM → SIGKILL before
    // "daemon stopped" can be written.
    try { servers.socket?.stop(true); } catch { /* */ }
    try { servers.api?.stop(true); } catch { /* */ }
    clearWsClients();

    try { cleanupAllWatchers(); } catch { /* */ }
    try { disposeAllMRSubscriptions(); } catch { /* */ }
    try { stopDiscussionsPoller(); } catch { /* */ }
    try { hooksGuard.closeAll(); } catch { /* */ }

    flushCache();

    // Remove runtime files
    for (const path of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* */ }
    }

    log.info("daemon stopped");
  };
}

/**
 * Graceful shutdown on all termination signals. SIGHUP is sent when the
 * parent process exits (e.g. launchd session ends, or a tray-spawned daemon's
 * parent tray is killed) — treat it as a clean stop.
 */
export function installSignalHandlers(opts: {
  cleanup: () => void;
  flushLogs: () => void;
  log: Logger;
}): void {
  const gracefulExit = (signal: NodeJS.Signals) => {
    opts.log.info({ signal }, "received signal; shutting down");
    opts.cleanup();
    opts.flushLogs();
    process.exit(0);
  };
  process.on("SIGTERM", () => gracefulExit("SIGTERM"));
  process.on("SIGINT",  () => gracefulExit("SIGINT"));
  process.on("SIGHUP",  () => gracefulExit("SIGHUP"));
}
