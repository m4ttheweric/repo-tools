#!/usr/bin/env bun

/**
 * rt daemon — Manage the rt background daemon.
 *
 * The daemon is an SMAppService LaunchAgent registered by rt-tray. The agent
 * plist + daemon binary both live inside rt-tray.app, and TCC attributes the
 * daemon's file accesses to the signed parent app via AssociatedBundleIdentifiers.
 * launchd handles supervision (KeepAlive + ThrottleInterval).
 *
 * Usage:
 *   rt daemon install     ensure tray has registered the daemon
 *   rt daemon uninstall   unregister daemon
 *   rt daemon start       register/start daemon (via tray)
 *   rt daemon stop        unregister/stop daemon
 *   rt daemon restart     kickstart daemon
 *   rt daemon status      show daemon state
 *   rt daemon logs        tail daemon log
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import {
  isDaemonInstalled,
  markDaemonInstalled, markDaemonUninstalled, cleanupDaemonFiles,
  readDaemonPid,
  DAEMON_LOG_PATH,
  DAEMON_STDERR_LOG_PATH,
  LAUNCHD_PLIST_PATH,
} from "../lib/daemon-config.ts";
import { daemonQuery, isDaemonRunning, trayQuery } from "../lib/daemon-client.ts";

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Clean up legacy launchd plist if it exists.
 * Pre-SMAppService rt versions wrote a plist to ~/Library/LaunchAgents/.
 * Removing it on install/uninstall prevents the old daemon from racing the
 * SMAppService-managed one.
 */
function cleanupLaunchdPlist(): boolean {
  if (!existsSync(LAUNCHD_PLIST_PATH)) return false;
  try { execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" }); } catch { /* */ }
  try { unlinkSync(LAUNCHD_PLIST_PATH); } catch { /* */ }
  return true;
}

// ─── Install ─────────────────────────────────────────────────────────────────

export async function install(_args: string[] = []): Promise<void> {
  // Persist the install marker so isDaemonInstalled() returns true and the
  // CLI will attempt to reach the daemon (rather than silently no-op).
  markDaemonInstalled();
  console.log(`  ${green}✓${reset} saved config to ~/.rt/daemon.json`);

  // Migrate away from any pre-SMAppService launchd plist.
  if (cleanupLaunchdPlist()) {
    console.log(`  ${green}✓${reset} removed legacy launchd plist`);
  }

  // Ask the tray to register the daemon. If the tray isn't running yet, it
  // will register on next launch.
  const trayResult = await trayQuery("/daemon/start", "POST");
  if (trayResult?.ok) {
    console.log(`  ${green}✓${reset} tray app is registering daemon`);
  } else {
    console.log(`  ${yellow}⚠${reset} rt-tray not reachable — open it to finish setup`);
    console.log(`  ${dim}  ${bold}open ~/Applications/rt-tray.app${reset}`);
  }

  // Wait for daemon to come online
  let connected = false;
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(250);
    if (await isDaemonRunning()) { connected = true; break; }
  }

  if (connected) {
    console.log(`  ${green}✓${reset} daemon is running`);
    console.log(`\n  ${green}${bold}✓ installed${reset} ${dim}— managed by rt-tray · launchd-supervised · TCC inherits from rt-tray.app${reset}\n`);
  } else {
    // Query the tray to find out WHY the daemon isn't responding
    const trayStatus = await trayQuery("/daemon/status", "GET");
    const smStatus = trayStatus?.ok ? (trayStatus as any).status : "unknown";

    console.log(`  ${yellow}⚠${reset} daemon not yet responding`);

    if (smStatus === "requiresApproval") {
      console.log(`  ${dim}macOS requires approval to run the background service.${reset}`);
      console.log(`  ${dim}Opening System Settings → Login Items — click ${bold}Allow${reset}${dim} next to rt-tray.${reset}`);
      console.log(`  ${dim}Then run: ${bold}rt daemon start${reset}\n`);
      try { execSync("open 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'", { stdio: "pipe" }); } catch { /* */ }
    } else if (smStatus === "notFound") {
      console.log(`  ${red}✗${reset} daemon binary not found inside rt-tray.app`);
      console.log(`  ${dim}Re-run: ${bold}rt --post-install${reset}${dim} to reinstall the tray app.${reset}\n`);
    } else if (smStatus === "enabled") {
      // Registered + approved, but daemon is crashing on launch
      console.log(`  ${dim}The agent is registered with launchd but the process keeps exiting.${reset}`);
      console.log(`  ${dim}Check logs: ${bold}rt daemon logs${reset}\n`);
    } else {
      // notRegistered, unknown, or tray unreachable
      console.log(`  ${dim}check logs: rt daemon logs${reset}\n`);
    }
  }
}

// ─── Uninstall ───────────────────────────────────────────────────────────────

export async function uninstall(): Promise<void> {
  // 1. Ask tray to unregister the SMAppService agent (stops launchd supervision).
  const result = await trayQuery("/daemon/stop", "POST");
  if (result?.ok) {
    console.log(`  ${green}✓${reset} daemon unregistered via tray`);
    await Bun.sleep(500);
  } else {
    console.log(`  ${dim}·${reset} tray not reachable — daemon may still be registered`);
  }

  // 2. Remove any legacy launchd plist.
  if (cleanupLaunchdPlist()) {
    console.log(`  ${green}✓${reset} removed legacy launchd plist`);
  }

  // 3. Clear install flag + sock/pid files.
  markDaemonUninstalled();
  cleanupDaemonFiles();
  console.log(`  ${green}✓${reset} cleared install flag`);

  console.log(`\n  ${dim}daemon fully uninstalled${reset}\n`);
}

// ─── Start / Stop / Restart ──────────────────────────────────────────────────

export async function start(): Promise<void> {
  if (!isDaemonInstalled()) {
    console.log(`\n  ${yellow}daemon is not installed${reset}`);
    console.log(`  ${dim}run: rt daemon install${reset}\n`);
    return;
  }

  if (await isDaemonRunning()) {
    console.log(`\n  ${green}daemon is already running${reset}\n`);
    return;
  }

  const result = await trayQuery("/daemon/start", "POST");
  if (!result?.ok) {
    console.log(`\n  ${yellow}rt-tray is not running${reset}`);
    console.log(`  ${dim}open it: ${bold}open ~/Applications/rt-tray.app${reset}\n`);
    return;
  }

  for (let i = 0; i < 12; i++) {
    await Bun.sleep(250);
    if (await isDaemonRunning()) {
      console.log(`\n  ${green}✓ daemon started${reset}\n`);
      return;
    }
  }
  console.log(`\n  ${yellow}daemon starting… check logs: rt daemon logs${reset}\n`);
}

export async function stop(): Promise<void> {
  const result = await trayQuery("/daemon/stop", "POST");
  if (result?.ok) {
    await Bun.sleep(500);
    console.log(`\n  ${green}✓ daemon stopped${reset}\n`);
    return;
  }
  console.log(`\n  ${yellow}rt-tray is not running — nothing to stop${reset}\n`);
}

export async function restart(): Promise<void> {
  const result = await trayQuery("/daemon/restart", "POST");
  if (!result?.ok) {
    console.log(`\n  ${yellow}rt-tray is not running${reset}`);
    console.log(`  ${dim}open it: ${bold}open ~/Applications/rt-tray.app${reset}\n`);
    return;
  }
  console.log(`  ${dim}restarting daemon via tray…${reset}`);
  for (let i = 0; i < 16; i++) {
    await Bun.sleep(500);
    if (await isDaemonRunning()) {
      console.log(`\n  ${green}✓ daemon restarted${reset}\n`);
      return;
    }
  }
  console.log(`\n  ${yellow}daemon restarting… check logs: rt daemon logs${reset}\n`);
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function showStatus(): Promise<void> {
  if (!isDaemonInstalled()) {
    console.log(`  ${dim}○${reset} not installed ${dim}(run rt daemon install)${reset}\n`);
    return;
  }

  const response = await daemonQuery("status");
  if (response?.ok) {
    const { pid, uptime, watchedRepos, cacheEntries } = response.data;
    console.log(`  ${green}●${reset} running ${dim}(SMAppService · pid ${pid} · uptime ${formatUptime(uptime)})${reset}`);
    console.log(`    ${dim}watching: ${watchedRepos} repo${watchedRepos !== 1 ? "s" : ""}${reset}`);
    console.log(`    ${dim}cache: ${cacheEntries} entries${reset}`);
  } else {
    const pid = readDaemonPid();
    console.log(`  ${red}●${reset} installed but not running`);
    if (pid) console.log(`    ${dim}last pid: ${pid}${reset}`);
    console.log(`    ${dim}run: rt daemon start${reset}`);
  }

  console.log(`    ${dim}config: ~/.rt/daemon.json${reset}`);
  console.log(`    ${dim}logs: ~/.rt/daemon.log${reset}`);
  console.log("");
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export function showLogs(): void {
  const hasMain = existsSync(DAEMON_LOG_PATH);
  const hasStderr = existsSync(DAEMON_STDERR_LOG_PATH);

  if (!hasMain && !hasStderr) {
    console.log(`\n  ${dim}no daemon logs yet${reset}\n`);
    return;
  }

  // Show launchd stderr first — it captures crashes before daemon.log is written
  if (hasStderr) {
    const stderr = readFileSync(DAEMON_STDERR_LOG_PATH, "utf8").trim();
    if (stderr) {
      console.log(`  ${bold}launchd stderr${reset} ${dim}(~/.rt/daemon-stderr.log)${reset}`);
      for (const line of stderr.split("\n").slice(-20)) {
        console.log(`  ${red}${line}${reset}`);
      }
      console.log("");
    }
  }

  if (hasMain) {
    const content = readFileSync(DAEMON_LOG_PATH, "utf8");
    const lines = content.trim().split("\n");
    const tail = lines.slice(-50);
    console.log(`  ${bold}daemon log${reset} ${dim}(last ${tail.length} lines — ~/.rt/daemon.log)${reset}`);
    for (const line of tail) {
      console.log(`  ${dim}${line}${reset}`);
    }
    console.log("");
  }
}
