#!/usr/bin/env bun

/**
 * rt daemon — Manage the rt background daemon.
 *
 * The daemon is spawned by rt-tray as a child process, inheriting the tray
 * app's TCC grants automatically (no Full Disk Access needed).
 *
 * Usage:
 *   rt daemon install     install daemon (tray-managed)
 *   rt daemon uninstall   stop + remove daemon
 *   rt daemon start       start daemon (via tray or direct fallback)
 *   rt daemon stop        stop daemon
 *   rt daemon restart     stop then start
 *   rt daemon status      show daemon state
 *   rt daemon logs        tail daemon log
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import {
  isDaemonInstalled, getDaemonConfig,
  markDaemonInstalled, markDaemonUninstalled, cleanupDaemonFiles,
  readDaemonPid, isDaemonProcessRunning,
  DAEMON_SOCK_PATH, DAEMON_PID_PATH, DAEMON_LOG_PATH,
  LAUNCHD_PLIST_PATH, RT_DIR,
} from "../lib/daemon-config.ts";
import { daemonQuery, isDaemonRunning, trayQuery } from "../lib/daemon-client.ts";

/**
 * Detect if rt is running as a compiled standalone binary.
 */
function isCompiledBinary(): boolean {
  return !process.execPath.includes("bun");
}

function resolveStableBrewPath(): string | null {
  for (const p of ["/opt/homebrew/bin/rt", "/usr/local/bin/rt"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveBunPath(): string {
  if (isCompiledBinary()) {
    return resolveStableBrewPath() ?? process.execPath;
  }
  try {
    return execSync("which bun", { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    console.log(`\n  ${red}bun not found on PATH${reset}\n`);
    process.exit(1);
  }
}

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
 * Called during install/migration to remove old launchd-managed daemon.
 */
function cleanupLaunchdPlist(): boolean {
  if (!existsSync(LAUNCHD_PLIST_PATH)) return false;
  try { execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" }); } catch { /* */ }
  try { unlinkSync(LAUNCHD_PLIST_PATH); } catch { /* */ }
  return true;
}

// ─── Install ─────────────────────────────────────────────────────────────────

export async function install(_args: string[] = []): Promise<void> {
  if (isDaemonInstalled()) {
    const config = getDaemonConfig()!;
    const running = await isDaemonRunning();

    // Migrate from old launchd/manual mode → tray mode
    if (config.mode !== "tray") {
      console.log(`\n  ${yellow}migrating daemon from ${config.mode} → tray${reset}`);
      await uninstall();
      // Fall through to fresh tray install
    } else if (running) {
      console.log(`\n  ${green}daemon is already installed and running${reset}`);
      await showStatus();
      return;
    } else {
      console.log(`\n  ${yellow}daemon is installed but not running — restarting…${reset}`);
      await start();
      return;
    }
  }

  console.log(`\n  ${bold}${cyan}rt daemon install${reset}\n`);

  const rtPath = resolveBunPath();
  const daemonScript = isCompiledBinary()
    ? undefined
    : resolve(new URL(import.meta.url).pathname, "../../lib/daemon.ts");

  if (!isCompiledBinary() && (!daemonScript || !existsSync(daemonScript))) {
    console.log(`  ${red}daemon script not found: ${daemonScript}${reset}\n`);
    process.exit(1);
  }

  // Persist install config
  markDaemonInstalled(rtPath, daemonScript ?? "--daemon", "tray");
  console.log(`  ${green}✓${reset} saved config to ~/.rt/daemon.json`);

  // Clean up any legacy launchd plist
  if (cleanupLaunchdPlist()) {
    console.log(`  ${green}✓${reset} removed old launchd plist`);
  }

  // Ask the tray to start the daemon (or it'll start on next tray launch)
  const trayResult = await trayQuery("/daemon/start", "POST");
  if (trayResult?.ok) {
    console.log(`  ${green}✓${reset} tray app is starting daemon`);
  } else {
    console.log(`  ${dim}·${reset} daemon will start when rt-tray launches`);
  }

  // Wait for daemon to be reachable
  let connected = false;
  for (let i = 0; i < 8; i++) {
    await Bun.sleep(250);
    if (await isDaemonRunning()) {
      connected = true;
      break;
    }
  }

  if (connected) {
    console.log(`  ${green}✓${reset} daemon is running`);
    console.log(`\n  ${green}${bold}✓ installed${reset} ${dim}— managed by rt-tray · auto TCC · crash recovery${reset}\n`);
  } else {
    console.log(`  ${yellow}⚠${reset} daemon started but not yet responding`);
    console.log(`  ${dim}check logs: rt daemon logs${reset}\n`);
  }
}

async function spawnDaemonProcess(): Promise<void> {
  const config = getDaemonConfig();
  const bin = config?.bunPath || "bun";

  const compiled = isCompiledBinary() || !config?.daemonScript || config.daemonScript === "--daemon";
  const spawnArgs = compiled ? ["--daemon"] : ["run", config!.daemonScript];

  const { spawn } = await import("child_process");
  const { openSync } = await import("fs");

  const logFd = openSync(DAEMON_LOG_PATH, "a");
  const child = spawn(bin, spawnArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: RT_DIR,
  });
  child.unref();

  console.log(`  ${green}✓${reset} spawned daemon (pid ${child.pid})`);
}

// ─── Uninstall ───────────────────────────────────────────────────────────────

export async function uninstall(): Promise<void> {
  console.log(`\n  ${bold}${cyan}rt daemon uninstall${reset}\n`);

  // 1. Stop daemon via tray first, then fall back to direct methods
  const config = getDaemonConfig();
  if (config?.mode === "tray") {
    const result = await trayQuery("/daemon/stop", "POST");
    if (result?.ok) {
      console.log(`  ${green}✓${reset} daemon stopped via tray`);
      await Bun.sleep(500);
    }
  }

  // 2. Graceful shutdown via socket (covers non-tray or tray fallback)
  if (await isDaemonRunning()) {
    const response = await daemonQuery("shutdown");
    if (response?.ok) {
      console.log(`  ${green}✓${reset} daemon stopped gracefully`);
      await Bun.sleep(200);
    } else if (isDaemonProcessRunning()) {
      const pid = readDaemonPid();
      if (pid) {
        try {
          process.kill(pid, "SIGTERM");
          console.log(`  ${green}✓${reset} daemon stopped (SIGTERM)`);
          await Bun.sleep(200);
        } catch { /* already dead */ }
      }
    }
  }

  // 3. Clean up legacy launchd plist
  if (cleanupLaunchdPlist()) {
    console.log(`  ${green}✓${reset} removed launchd agent`);
  }

  // 4. Clear install flag
  markDaemonUninstalled();
  console.log(`  ${green}✓${reset} cleared install flag`);

  // 5. Clean up runtime files
  cleanupDaemonFiles();
  console.log(`  ${green}✓${reset} cleaned up socket and pid files`);

  console.log(`\n  ${dim}daemon fully uninstalled${reset}\n`);
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

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

  // Evict orphan processes
  if (isDaemonProcessRunning()) {
    const pid = readDaemonPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  ${yellow}⚠${reset} evicted stale daemon process (pid ${pid})`);
        await Bun.sleep(400);
      } catch { /* already dead */ }
    }
    for (const p of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* */ }
    }
  }

  // Try tray first, fall back to direct spawn
  const result = await trayQuery("/daemon/start", "POST");
  if (!result?.ok) {
    console.log(`  ${yellow}⚠${reset} tray not reachable — spawning daemon directly`);
    await spawnDaemonProcess();
  }

  await Bun.sleep(600);

  if (await isDaemonRunning()) {
    console.log(`\n  ${green}✓ daemon started${reset}\n`);
  } else {
    console.log(`\n  ${yellow}daemon starting… check logs: rt daemon logs${reset}\n`);
  }
}

/** Poll until a process is dead or the timeout elapses. Returns true if dead. */
async function waitForProcessDeath(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await Bun.sleep(100);
    } catch {
      return true;
    }
  }
  return false;
}

function cleanupRuntimeFiles(): void {
  for (const p of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
  }
}

export async function stop(): Promise<void> {
  // Try tray first
  const result = await trayQuery("/daemon/stop", "POST");
  if (result?.ok) {
    await Bun.sleep(500);
    console.log(`\n  ${green}✓ daemon stopped${reset}\n`);
    return;
  }

  const pidBefore = readDaemonPid();

  // Graceful shutdown via socket
  const response = await daemonQuery("shutdown");
  if (response?.ok) {
    if (pidBefore) {
      const died = await waitForProcessDeath(pidBefore, 3000);
      if (!died) {
        try { process.kill(pidBefore, "SIGKILL"); } catch { /* already dead */ }
      }
    } else {
      await Bun.sleep(300);
    }
    cleanupRuntimeFiles();
    console.log(`\n  ${green}✓ daemon stopped${reset}\n`);
    return;
  }

  // SIGTERM via PID file
  if (isDaemonProcessRunning()) {
    const pid = readDaemonPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        const died = await waitForProcessDeath(pid, 2000);
        if (!died) {
          process.kill(pid, "SIGKILL");
          await Bun.sleep(200);
        }
        cleanupRuntimeFiles();
        console.log(`\n  ${green}✓ daemon stopped${reset}\n`);
      } catch {
        console.log(`\n  ${red}failed to stop daemon${reset}\n`);
      }
      return;
    }
  }

  console.log(`\n  ${dim}daemon is not running${reset}\n`);
}

export async function restart(): Promise<void> {
  const result = await trayQuery("/daemon/restart", "POST");
  if (result?.ok) {
    console.log(`  ${dim}restarting daemon via tray…${reset}`);
    for (let i = 0; i < 16; i++) {
      await Bun.sleep(500);
      if (await isDaemonRunning()) {
        console.log(`\n  ${green}✓ daemon restarted${reset}\n`);
        return;
      }
    }
    console.log(`\n  ${yellow}daemon restarting… check logs: rt daemon logs${reset}\n`);
    return;
  }

  // Tray not reachable — direct restart
  const wasRunning = (await isDaemonRunning()) || isDaemonProcessRunning();
  if (wasRunning) {
    await stop();
  } else {
    console.log(`  ${dim}daemon was not running — starting fresh${reset}`);
  }
  await start();
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function showStatus(): Promise<void> {
  console.log(`\n  ${bold}${cyan}rt daemon${reset}\n`);

  if (!isDaemonInstalled()) {
    console.log(`  ${dim}○${reset} not installed ${dim}(run rt daemon install)${reset}\n`);
    return;
  }

  const response = await daemonQuery("status");
  if (response?.ok) {
    const { pid, uptime, watchedRepos, cacheEntries } = response.data;
    console.log(`  ${green}●${reset} running ${dim}(tray-managed · pid ${pid} · uptime ${formatUptime(uptime)})${reset}`);
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
  if (!existsSync(DAEMON_LOG_PATH)) {
    console.log(`\n  ${dim}no daemon logs yet${reset}\n`);
    return;
  }

  const content = readFileSync(DAEMON_LOG_PATH, "utf8");
  const lines = content.trim().split("\n");
  const tail = lines.slice(-50);
  console.log(`\n  ${bold}${cyan}rt daemon logs${reset} ${dim}(last ${tail.length} lines)${reset}\n`);
  for (const line of tail) {
    console.log(`  ${dim}${line}${reset}`);
  }
  console.log("");
}
