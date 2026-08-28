/**
 * Monotonic liveness heartbeat, written to a small file via atomic rename so
 * it never opens state.db. A stalled/lock-wedged daemon is exactly when the
 * WAL is least readable, so the cross-process classifier reads THIS, not kv.
 * Same db-free pattern as the Phase 0 breadcrumb.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

export interface Heartbeat {
  at: number;
  seq: number;
}

function heartbeatPath(dir: string): string {
  return join(dir, "daemon-heartbeat.json");
}

/** Never fatal: a heartbeat is a diagnostic aid, not something a tick may fail over. */
export function writeHeartbeat(dir: string, hb: Heartbeat): void {
  try {
    const tmp = `${heartbeatPath(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(hb));
    renameSync(tmp, heartbeatPath(dir));
  } catch {
    // best-effort
  }
}

export function readHeartbeat(dir: string): Heartbeat | null {
  try {
    const p = heartbeatPath(dir);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}
