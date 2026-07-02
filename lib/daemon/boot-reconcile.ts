/**
 * Self-healing startup reconciliation.
 *
 *  - evictStaleDaemon: kill a previous daemon process that is still alive
 *    (orphan from a failed restart) before we bind the socket.
 */

import type { Logger } from "pino";
import { readDaemonPid } from "../daemon-config.ts";

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
