/**
 * Daemon client — thin IPC layer for CLI → daemon communication.
 *
 * Uses HTTP over Unix socket (Bun.serve on the daemon side).
 * Gracefully degrades when daemon is not installed or not running:
 *  - Not installed → returns null silently
 *  - Installed but down → attempts launchctl restart, warns if that fails
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import {
  isDaemonInstalled,
  getDaemonConfig,
  DAEMON_SOCK_PATH,
  TRAY_SOCK_PATH,
  LAUNCHD_LABEL,
} from "./daemon-config.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DaemonResponse {
  ok: boolean;
  data?: any;
  error?: string;
}

// ─── HTTP over Unix socket ───────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 2000;

async function trySocketQuery(
  cmd: string,
  payload?: Record<string, any>,
): Promise<DaemonResponse | null> {
  if (!existsSync(DAEMON_SOCK_PATH)) return null;

  try {
    const hasBody = payload && Object.keys(payload).length > 0;

    const response = await fetch(`http://localhost/${cmd}`, {
      unix: DAEMON_SOCK_PATH,
      method: hasBody ? "POST" : "GET",
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    } as any);

    return (await response.json()) as DaemonResponse;
  } catch {
    return null;
  }
}

// ─── Tray socket query ──────────────────────────────────────────────────────

export async function trayQuery(
  endpoint: string,
  method: "GET" | "POST" = "POST",
): Promise<DaemonResponse | null> {
  if (!existsSync(TRAY_SOCK_PATH)) return null;

  try {
    const response = await fetch(`http://localhost${endpoint}`, {
      unix: TRAY_SOCK_PATH,
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    } as any);

    return (await response.json()) as DaemonResponse;
  } catch {
    return null;
  }
}

export function isTrayReachable(): boolean {
  return existsSync(TRAY_SOCK_PATH);
}

// ─── Auto-recovery ───────────────────────────────────────────────────────────

let hasWarnedThisSession = false;

function attemptRestart(): boolean {
  try {
    const config = getDaemonConfig();
    if (!config) return false;

    if (config.mode === "tray") {
      // In tray mode, ask the tray app to start the daemon
      // (fire-and-forget — we'll retry the query after a delay)
      trayQuery("/daemon/start", "POST");
    } else if (config.mode === "launchd") {
      execSync(`launchctl kickstart gui/$(id -u)/${LAUNCHD_LABEL}`, {
        stdio: "pipe",
        timeout: 3000,
      });
    } else {
      // manual mode: spawn detached
      const { openSync } = require("fs");
      const { spawn } = require("child_process");
      const { DAEMON_LOG_PATH, RT_DIR } = require("./daemon-config.ts");
      const logFd = openSync(DAEMON_LOG_PATH, "a");
      const child = spawn(config.bunPath, ["run", config.daemonScript], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: RT_DIR,
      });
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

function warnDaemonDown(): void {
  if (hasWarnedThisSession) return;
  hasWarnedThisSession = true;
  console.error(
    "  \x1b[33m⚠\x1b[0m rt daemon is installed but not running. Run: \x1b[1mrt daemon start\x1b[0m",
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a command to the daemon and return the response.
 *
 * Returns null if daemon is not available (either not installed or not running
 * and can't be auto-restarted). Callers should fall back to direct execution.
 */
export async function daemonQuery(
  cmd: string,
  payload?: Record<string, any>,
): Promise<DaemonResponse | null> {
  // 1. Try HTTP request over Unix socket
  const result = await trySocketQuery(cmd, payload);
  if (result !== null) return result;

  // 2. Check if user opted in
  if (!isDaemonInstalled()) return null; // not installed → silent fallback

  // 3. If the socket file still exists, the daemon IS running — this query
  //    simply timed out or hit a transient error (daemon busy, slow git op,
  //    etc.). Return null silently; do NOT warn or attempt a restart, which
  //    would bleed "daemon not running" text into the TUI.
  if (existsSync(DAEMON_SOCK_PATH)) return null;

  // 4. Socket is gone → daemon is genuinely not running. Attempt restart.
  const restarted = attemptRestart();
  if (restarted) {
    // Retry once after short delay
    await Bun.sleep(300);
    const retryResult = await trySocketQuery(cmd, payload);
    if (retryResult !== null) return retryResult;
  }

  // 5. Restart failed → warn (once per session)
  warnDaemonDown();
  return null;
}

/**
 * Quick check: is the daemon reachable right now?
 */
export async function isDaemonRunning(): Promise<boolean> {
  const response = await trySocketQuery("ping");
  return response?.ok === true;
}
