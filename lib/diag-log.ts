/**
 * Diagnostic log — append-only, shared by daemon + runner + CLI.
 *
 * Writes to ~/.rt/diag.log. Kept separate from daemon.log so diagnostic traces
 * aren't clobbered by the daemon's stdio redirect (which is not O_APPEND in
 * tray mode) or by stale-process writes.
 *
 * Each process stamps its role + pid so interleaved writes from daemon,
 * runner, and spawnDaemonProcess callers can be untangled.
 *
 * Safe to call from any context — all errors are swallowed so instrumentation
 * never brings down a caller.
 */

import { openSync, writeSync, closeSync, statSync, renameSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DIAG_LOG_PATH = join(homedir(), ".rt", "diag.log");
const ROTATE_BYTES = 5 * 1024 * 1024; // 5 MB

let cachedRole: string | null = null;

function detectRole(): string {
  const argv = process.argv.slice(1).join(" ");
  if (argv.includes("--daemon")) return "daemon";
  if (argv.includes("runner")) return "runner";
  return "cli";
}

function role(): string {
  if (cachedRole === null) cachedRole = detectRole();
  return cachedRole;
}

function rotateIfNeeded(): void {
  try {
    const st = statSync(DIAG_LOG_PATH);
    if (st.size > ROTATE_BYTES) {
      renameSync(DIAG_LOG_PATH, DIAG_LOG_PATH + ".1");
    }
  } catch { /* file missing or unreadable — ignore */ }
}

/**
 * Append a single diagnostic line. Opens + closes the FD per call so we never
 * leak descriptors (this is the opposite of the spawnDaemonProcess bug that
 * flooded daemon.log — we explicitly avoid holding the handle).
 */
export function diag(tag: string, msg: string, extra?: Record<string, unknown>): void {
  try {
    rotateIfNeeded();
    const ts = new Date().toISOString();
    const suffix = extra ? " " + JSON.stringify(extra) : "";
    const line = `[${ts}] ${role()}:${process.pid} ${tag} ${msg}${suffix}\n`;
    const fd = openSync(DIAG_LOG_PATH, "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch { /* diagnostic logging must never throw */ }
}

/** Check if a path exists — small helper kept here so callers don't re-import fs. */
export function diagLogExists(): boolean {
  return existsSync(DIAG_LOG_PATH);
}

export { DIAG_LOG_PATH };
