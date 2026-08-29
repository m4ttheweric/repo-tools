/**
 * Self-healing startup reconciliation.
 *
 *  - evictStaleDaemon: kill a previous daemon process that is still alive
 *    (orphan from a failed restart) before we bind the socket.
 */

import type { Logger } from "pino";
import { readDaemonPid } from "../daemon-config.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, throws if not alive
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll every ~100ms until `pid` is gone or `maxMs` elapses. */
async function waitForDeath(pid: number, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
  return true;
}

/**
 * Evict a still-alive previous daemon. This is the last line of defence when
 * the `start` command's orphan-detection doesn't fire (e.g. launchd relaunches
 * us automatically without going through `rt daemon start`).
 *
 * Waits for the old process to actually die rather than a blind sleep: a
 * daemon that survives the eviction window can still race the new one for
 * rt.sock/rt.pid (S044). Escalates to SIGKILL if SIGTERM alone doesn't land.
 */
export async function evictStaleDaemon(log: Logger): Promise<void> {
  const previousPid = readDaemonPid();
  if (!previousPid || previousPid === process.pid) return;
  if (!isAlive(previousPid)) return;
  try {
    process.kill(previousPid, "SIGTERM");
  } catch (err) {
    // Exited between the liveness probe and this send (ESRCH), or is not
    // ours (EPERM). Nothing left to evict either way.
    log.warn({ err, pid: previousPid }, "stale daemon SIGTERM skipped");
    return;
  }
  log.warn({ pid: previousPid }, "evicted stale daemon process");
  if (await waitForDeath(previousPid, 2500)) return;
  try {
    process.kill(previousPid, "SIGKILL");
  } catch { /* already gone */ }
  await waitForDeath(previousPid, 500);
}
