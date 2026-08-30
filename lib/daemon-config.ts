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
import { dirname, join } from "path";
import { rtDir } from "./rt-paths.ts";
import { currentMode } from "./dev-mode.ts";
import { getSetting } from "./settings/resolve.ts";

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
export const LAUNCHD_LABEL = "com.mattstack.daemon";

/**
 * The launchd label of whichever daemon flavor is ACTIVE right now
 * (MAT-383 §1) — dev builds run under a separate label so the two flavors'
 * daemon agents never fight over the same job. currentMode() (lib/dev-mode.ts)
 * is the only flavor signal; dev-mode.json's existence is deliberately not
 * one (see that module's docblock).
 */
export function activeLaunchdLabel(): string {
  return currentMode() === "dev" ? "com.mattstack.daemon.dev" : "com.mattstack.daemon";
}
export const TRAY_SOCK_PATH = join(RT_DIR, "tray.sock");
// NOTE: NOTIFY_QUEUE_PATH removed (RT-48) — the notification queue is the
// `notify_queue` table in state.db, not a file. See lib/state/notifier-store.ts.

/** Daemon HTTP/WS port. Shared so clients can open WS connections without
 *  re-declaring the constant. RT_API_PORT overrides it so an isolated daemon
 *  (e2e spawns a real foreground one) never collides with a live local
 *  daemon's hardcoded port (RT-45). */
export const API_PORT = Number(process.env.RT_API_PORT) || 9401;

/**
 * Call-time API port resolution: RT_API_PORT env wins (e2e isolation, RT-45),
 * then the rt.apiPort setting (escape hatch when 9401 is held), then 9401.
 * A function, not a const: it must never be evaluated at module load, since
 * getSetting() reads the settings stores off ambient HOME.
 */
export function resolveApiPort(): number {
  // process.env.RT_API_PORT === "0" is a deliberate override, not "unset" —
  // `Number(env) || ...` treats 0 as falsy and silently falls through to the
  // setting/default instead of honoring it (R2).
  if (process.env.RT_API_PORT !== undefined) {
    const env = Number(process.env.RT_API_PORT);
    if (!Number.isNaN(env)) return env;
  }
  try {
    return getSetting<number>("rt.apiPort").value || 9401;
  } catch {
    return 9401;
  }
}

// ─── Read / Write ────────────────────────────────────────────────────────────

// `home`, when passed, overrides the module-load `DAEMON_CONFIG_PATH` const
// with a path under that specific home instead — the apply engine's
// services.register step (lib/setup/steps/services.ts) passes `ctx.p.home`
// so a faked Probes' home is the one this ever writes into during a test,
// never whatever real HOME happened to be live when this module first
// loaded. Every OTHER caller (the daemon itself, `rt daemon install`,
// daemon-client.ts) omits it and keeps today's exact behavior — this is
// additive, not a switch to ambient call-time HOME resolution (which would
// make this pair newly sensitive to HOME mutations any OTHER test file
// leaves behind, an isolation regression discovered and rejected while
// building this).
function daemonConfigPath(home?: string): string {
  return home !== undefined ? join(home, ".mattstack", "rt", "daemon.json") : DAEMON_CONFIG_PATH;
}

export function getDaemonConfig(home?: string): DaemonConfig | null {
  try {
    const raw = JSON.parse(readFileSync(daemonConfigPath(home), "utf8"));
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

export function markDaemonInstalled(home?: string): void {
  const path = daemonConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const config: DaemonConfig = {
    installed: true,
    installedAt: new Date().toISOString(),
    mode: "smappservice",
  };
  writeFileSync(path, JSON.stringify(config, null, 2));
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
