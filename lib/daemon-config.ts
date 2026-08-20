/**
 * Persisted daemon configuration.
 *
 * Stores install state in ~/.mattstack/rt/daemon.json so rt commands can
 * distinguish
 * "daemon not installed (silent fallback)" from "daemon installed but not
 * running (attempt restart, warn if that fails)".
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { rtDir } from "./rt-paths.ts";
import { currentMode } from "./dev-mode.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Only one mode now ("smappservice"): the daemon is a LaunchAgent registered
 * by mattstack.app via SMAppService. The legacy values ("launchd", "manual", "tray")
 * may appear in old daemon.json files written by previous rt versions —
 * `getDaemonConfig` migrates them on read.
 */
export type DaemonMode = "smappservice";

export interface DaemonConfig {
  installed: boolean;
  installedAt: string;
  mode: DaemonMode;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

// Evaluated at module load, deliberately: the bun test preload (test-setup.ts)
// repoints HOME before any module loads, so this const still lands in the
// per-test throwaway tree. Anything needing true call-time resolution should
// use rtDir() from rt-paths.ts directly.
export const RT_DIR = rtDir();
export const DAEMON_CONFIG_PATH = join(RT_DIR, "daemon.json");
export const DAEMON_SOCK_PATH = join(RT_DIR, "rt.sock");
export const DAEMON_PID_PATH = join(RT_DIR, "rt.pid");
export const LOG_DIR = join(RT_DIR, "logs");
// pino-roll's actual filename pattern (with extension=".log", dateFormat,
// frequency:"daily") is `daemon.YYYY-MM-DD.N.log`. DAEMON_LOG_PATH is the
// base path callers can use to derive the directory or pattern.
export const DAEMON_LOG_PATH = join(LOG_DIR, "daemon.log");
// NOTE: DAEMON_STDERR_LOG_PATH removed — JS-side stderr is captured by the logger
// (see lib/daemon.ts startup). Native stderr capture is deferred to the swift-shim.
export const LAUNCHD_PLIST_PATH = join(
  homedir(), "Library", "LaunchAgents", "com.rt.daemon.plist",
);
export const LAUNCHD_LABEL = "com.rt.daemon";

/**
 * The launchd label of whichever daemon flavor is ACTIVE right now
 * (MAT-383 §1) — dev builds run under a separate label so the two flavors'
 * daemon agents never fight over the same job. currentMode() (lib/dev-mode.ts)
 * is the only flavor signal; dev-mode.json's existence is deliberately not
 * one (see that module's docblock).
 */
export function activeLaunchdLabel(): string {
  return currentMode() === "dev" ? "com.rt.daemon.dev" : "com.rt.daemon";
}
export const TRAY_SOCK_PATH = join(RT_DIR, "tray.sock");
export const NOTIFY_QUEUE_PATH = join(RT_DIR, "notify-queue.json");

/** Daemon HTTP/WS port. Shared so clients can open WS connections without
 *  re-declaring the constant. RT_API_PORT overrides it so an isolated daemon
 *  (e2e spawns a real foreground one) never collides with a live local
 *  daemon's hardcoded port (RT-45). */
export const API_PORT = Number(process.env.RT_API_PORT) || 9401;

// ─── Read / Write ────────────────────────────────────────────────────────────

export function getDaemonConfig(): DaemonConfig | null {
  try {
    const raw = JSON.parse(readFileSync(DAEMON_CONFIG_PATH, "utf8"));
    if (!raw.installed) return null;
    // Normalize legacy modes ("launchd", "manual", "tray") → "smappservice".
    return {
      installed: true,
      installedAt: String(raw.installedAt ?? new Date().toISOString()),
      mode: "smappservice",
    };
  } catch {
    return null;
  }
}

export function isDaemonInstalled(): boolean {
  return getDaemonConfig() !== null;
}

export function markDaemonInstalled(): void {
  mkdirSync(RT_DIR, { recursive: true });
  const config: DaemonConfig = {
    installed: true,
    installedAt: new Date().toISOString(),
    mode: "smappservice",
  };
  writeFileSync(DAEMON_CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function markDaemonUninstalled(): void {
  try {
    if (existsSync(DAEMON_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(DAEMON_CONFIG_PATH, "utf8"));
      raw.installed = false;
      writeFileSync(DAEMON_CONFIG_PATH, JSON.stringify(raw, null, 2));
    }
  } catch { /* best-effort */ }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export function cleanupDaemonFiles(): void {
  for (const path of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch { /* best-effort */ }
  }
}

// ─── PID ─────────────────────────────────────────────────────────────────────

export function readDaemonPid(): number | null {
  try {
    const pid = parseInt(readFileSync(DAEMON_PID_PATH, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isDaemonProcessRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}
