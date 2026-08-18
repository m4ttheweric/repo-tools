/**
 * CI-attendant lease probe (BOARD-10).
 *
 * An attendant (a CI-babysitting agent) writes a heartbeat file per MR it is
 * attending into ~/.mattstack/ci-attendants/. Disposal defers to the next tick
 * while such a lease is fresh: reaping a tree out from under an agent that is
 * still pushing fixes to its MR is the one un-undoable mistake here.
 *
 * The on-disk shape is BOARD-10's, verified against real files — `mr` is the MR
 * *URL string* (not an iid) and `heartbeatAt` is epoch millis (not ISO). This
 * module reads that shape and never writes it: rt is a reader of someone else's
 * coordination state (~/.mattstack is cross-actor, no single owner).
 *
 * Everything here is deliberately forgiving. An unreadable, half-written, or
 * schema-drifted lease file yields "not attended" rather than an exception: a
 * garbage file must never wedge the disposal path forever.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Attendant heartbeats older than this (when the file declares no ttl) are stale. */
const DEFAULT_TTL_SECONDS = 300;

/**
 * ~/.mattstack/ci-attendants — HOME resolved at CALL time (same convention as
 * lib/rt-paths.ts) so a test pointing process.env.HOME at a temp dir isolates
 * the real one.
 */
export function ciAttendantsDir(): string {
  return join(process.env.HOME ?? homedir(), ".mattstack", "ci-attendants");
}

/** Epoch millis from either the real (number) or a defensively-tolerated (ISO) heartbeat. */
function heartbeatMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Whether a lease's `mr` URL points at this iid (trailing /merge_requests/<iid>). */
function urlMatchesIid(mr: unknown, mrIid: number): boolean {
  if (typeof mr !== "string") return false;
  return mr.replace(/\/+$/, "").endsWith(`/merge_requests/${mrIid}`);
}

/**
 * Whether some attendant currently holds a fresh lease on this MR.
 *
 * Matching is belt-and-braces: the filename convention is
 * `<project>-<iid>.json`, but the authoritative field is the `mr` URL, so
 * either identifies the MR. `now` is injectable for tests.
 */
export function hasFreshAttendantLease(mrIid: number, now: number = Date.now()): boolean {
  const dir = ciAttendantsDir();
  if (!existsSync(dir)) return false;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return false;
  }

  for (const file of files) {
    let lease: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!raw || typeof raw !== "object") continue;
      lease = raw as Record<string, unknown>;
    } catch {
      continue; // unreadable or half-written — never block on garbage
    }

    const matches = urlMatchesIid(lease.mr, mrIid) || file.endsWith(`-${mrIid}.json`);
    if (!matches) continue;

    const heartbeat = heartbeatMillis(lease.heartbeatAt);
    if (heartbeat === null) continue;

    const ttlSeconds =
      typeof lease.ttlSeconds === "number" && Number.isFinite(lease.ttlSeconds)
        ? lease.ttlSeconds
        : DEFAULT_TTL_SECONDS;

    if (now - heartbeat < ttlSeconds * 1000) return true;
  }

  return false;
}
