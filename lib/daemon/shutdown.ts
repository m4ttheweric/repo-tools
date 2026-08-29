/**
 * Shutdown sequence — tears down servers, managed processes, watchers, and
 * runtime files in an order that beats launchd's 5s ExitTimeOut.
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import type { Logger } from "pino";
import { DAEMON_SOCK_PATH, DAEMON_PID_PATH } from "../daemon-config.ts";
import { recordCleanExit } from "./supervision-state.ts";

/**
 * Remove rt.pid and rt.sock, but only if rt.pid still names THIS process.
 * A shutting-down old daemon that unlinks unconditionally can delete a new
 * daemon's rt.sock/rt.pid out from under it (S012/S044). This is the rt-pid
 * unit's stop step.
 */
export function removeRuntimeFiles(opts: { pid?: number; log: Logger }): void {
  const pid = opts.pid ?? process.pid;
  try {
    if (existsSync(DAEMON_PID_PATH) && readFileSync(DAEMON_PID_PATH, "utf8").trim() === String(pid)) {
      unlinkSync(DAEMON_PID_PATH);
      if (existsSync(DAEMON_SOCK_PATH)) unlinkSync(DAEMON_SOCK_PATH);
    }
  } catch (err) { opts.log.warn({ err }, "cleanup unlink skipped"); }
}

export interface GracefulExitDeps {
  /** Reverse-order unit teardown (`stopUnits`); awaited so every unit's stop
   *  completes before the process exits. */
  cleanup: () => void | Promise<void>;
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
 * stay down) from a bare external signal (pkill, memory pressure, a stray
 * script, exit 1, launchd respawns). The sanctioned stop path
 * (SMAppService.unregister) doesn't go through this signal path at all, so
 * exiting non-zero on a bare signal never fights an intended stop.
 */
export function makeGracefulExit(deps: GracefulExitDeps): (signal: NodeJS.Signals) => Promise<void> {
  return async (signal: NodeJS.Signals) => {
    deps.log.info({ signal }, "received signal; shutting down");
    // Await the reverse-order stop: the unit stops force-close the servers and
    // unlink runtime files, and a sync exit here would run only the first of
    // them, because stopUnits yields to microtasks between units.
    await deps.cleanup();
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
  cleanup: () => void | Promise<void>;
  flushLogs: () => void;
  log: Logger;
  wasVerbShutdown: () => boolean;
}): void {
  const gracefulExit = makeGracefulExit({ ...opts, exit: process.exit, recordCleanExit });
  process.on("SIGTERM", () => gracefulExit("SIGTERM"));
  process.on("SIGINT",  () => gracefulExit("SIGINT"));
  process.on("SIGHUP",  () => gracefulExit("SIGHUP"));
}
