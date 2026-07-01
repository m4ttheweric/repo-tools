/**
 * Self-healing startup reconciliation.
 *
 *  - evictStaleDaemon: kill a previous daemon process that is still alive
 *    (orphan from a failed restart) before we bind the socket.
 *  - reapOrphanProcesses: on restart most children are gone, but warm
 *    (SIGSTOP'd) processes survive as orphans reparented to init. Reap any
 *    whose pid we still have recorded.
 */

import type { Logger } from "pino";
import { readDaemonPid } from "../daemon-config.ts";
import { killGroup } from "./process-manager.ts";
import type { StateStore } from "./state-store.ts";

/**
 * Evict a still-alive previous daemon. This is the last line of defence when
 * the `start` command's orphan-detection doesn't fire (e.g. launchd relaunches
 * us automatically without going through `rt daemon start`).
 */
export function evictStaleDaemon(log: Logger): void {
  const previousPid = readDaemonPid();
  if (!previousPid || previousPid === process.pid) return;
  try {
    process.kill(previousPid, 0); // throws if not alive
    process.kill(previousPid, "SIGTERM");
    log.warn({ pid: previousPid }, "evicted stale daemon process");
    // Brief pause so the old process can exit and release any shared resources
    Bun.sleepSync(300);
  } catch { /* process not found — nothing to evict */ }
}

/**
 * Reap orphaned children recorded by a previous daemon run:
 * SIGCONT first (so a SIGSTOP'd pgroup can actually handle signals), then SIGKILL.
 */
export function reapOrphanProcesses(stateStore: StateStore, log: Logger): void {
  const orphans = stateStore.reconcileAfterRestart();
  for (const { id, pid } of orphans) {
    try {
      process.kill(pid, 0); // probe — throws if pid is no longer live
      killGroup(pid, "SIGCONT");
      killGroup(pid, "SIGKILL");
      log.warn({ id, pid }, "reaped orphan process");
    } catch { /* pid already gone */ }
  }
}
