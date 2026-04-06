/**
 * Persisted daemon configuration.
 *
 * Stores install state in ~/.rt/daemon.json so rt commands can distinguish
 * "daemon not installed (silent fallback)" from "daemon installed but not
 * running (attempt restart, warn if that fails)".
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DaemonMode = "launchd" | "manual" | "tray";

export interface DaemonConfig {
  installed: boolean;
  installedAt: string;
  bunPath: string;
  daemonScript: string;
  mode: DaemonMode;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export const RT_DIR = join(homedir(), ".rt");
export const DAEMON_CONFIG_PATH = join(RT_DIR, "daemon.json");
export const DAEMON_SOCK_PATH = join(RT_DIR, "rt.sock");
export const DAEMON_PID_PATH = join(RT_DIR, "rt.pid");
export const DAEMON_LOG_PATH = join(RT_DIR, "daemon.log");
export const LAUNCHD_PLIST_PATH = join(
  homedir(), "Library", "LaunchAgents", "com.rt.daemon.plist",
);
export const LAUNCHD_LABEL = "com.rt.daemon";
export const TRAY_SOCK_PATH = join(RT_DIR, "tray.sock");
export const NOTIFY_QUEUE_PATH = join(RT_DIR, "notify-queue.json");

// ─── Read / Write ────────────────────────────────────────────────────────────

export function getDaemonConfig(): DaemonConfig | null {
  try {
    const raw = JSON.parse(readFileSync(DAEMON_CONFIG_PATH, "utf8"));
    if (!raw.installed) return null;
    return raw as DaemonConfig;
  } catch {
    return null;
  }
}

export function isDaemonInstalled(): boolean {
  return getDaemonConfig() !== null;
}

export function markDaemonInstalled(bunPath: string, daemonScript: string, mode: DaemonMode = "manual"): void {
  mkdirSync(RT_DIR, { recursive: true });
  const config: DaemonConfig = {
    installed: true,
    installedAt: new Date().toISOString(),
    bunPath,
    daemonScript,
    mode,
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
