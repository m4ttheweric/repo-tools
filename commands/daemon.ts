#!/usr/bin/env bun

/**
 * rt daemon — Manage the rt background daemon.
 *
 * Usage:
 *   rt daemon install     install + start daemon (launchd)
 *   rt daemon uninstall   stop + remove daemon
 *   rt daemon start       start daemon (if installed)
 *   rt daemon stop        stop daemon gracefully (waits for process death)
 *   rt daemon restart     stop then start (clean handoff, no orphans)
 *   rt daemon status      show daemon state
 *   rt daemon logs        tail daemon log
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import {
  isDaemonInstalled, getDaemonConfig,
  markDaemonInstalled, markDaemonUninstalled, cleanupDaemonFiles,
  readDaemonPid, isDaemonProcessRunning,
  DAEMON_SOCK_PATH, DAEMON_PID_PATH, DAEMON_LOG_PATH,
  LAUNCHD_PLIST_PATH, LAUNCHD_LABEL, RT_DIR,
  type DaemonMode,
} from "../lib/daemon-config.ts";
import { daemonQuery, isDaemonRunning } from "../lib/daemon-client.ts";

/**
 * Detect if rt is running as a compiled standalone binary.
 * In compiled mode, process.execPath points to the rt binary itself,
 * not to the bun runtime.
 */
function isCompiledBinary(): boolean {
  return !process.execPath.includes("bun");
}

function resolveBunPath(): string {
  if (isCompiledBinary()) return process.execPath; // compiled: use self
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

function generatePlist(rtPath: string, daemonScript?: string): string {
  // In compiled mode: single arg `rt --daemon`
  // In source mode: `bun run <script>`
  const argsXml = isCompiledBinary()
    ? `        <string>${rtPath}</string>
        <string>--daemon</string>`
    : `        <string>${rtPath}</string>
        <string>run</string>
        <string>${daemonScript}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${DAEMON_LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${DAEMON_LOG_PATH}</string>
    <key>WorkingDirectory</key>
    <string>${RT_DIR}</string>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>`;
}

// ─── Install ─────────────────────────────────────────────────────────────────

export async function install(args: string[] = []): Promise<void> {
  if (isDaemonInstalled()) {
    const config = getDaemonConfig()!;
    const running = await isDaemonRunning();

    // For launchd installs, check whether the on-disk plist matches what we'd
    // generate now. If it drifted (post-upgrade with new plist keys), refresh it.
    // Done before the early-return paths so `rt update` → post-install picks up
    // changes like new LimitLoadToSessionType / ProcessType keys.
    if (config.mode === "launchd" && existsSync(LAUNCHD_PLIST_PATH)) {
      const currentPlist = readFileSync(LAUNCHD_PLIST_PATH, "utf8");
      const expectedPlist = generatePlist(config.bunPath, config.daemonScript);
      if (currentPlist !== expectedPlist) {
        console.log(`\n  ${yellow}launchd plist is out of date — refreshing${reset}`);
        writeFileSync(LAUNCHD_PLIST_PATH, expectedPlist);
        try {
          execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" });
        } catch { /* not loaded */ }
        try {
          execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`, { stdio: "pipe" });
          console.log(`  ${green}✓${reset} reloaded launchd agent with refreshed plist`);
        } catch (err) {
          console.log(`  ${red}✗${reset} failed to reload launchd agent: ${err}`);
        }
      }
    }

    if (running && process.stdin.isTTY) {
      const currentLabel = config.mode === "launchd" ? "launchd agent" : "background process";
      console.log(`\n  ${green}daemon is running${reset} ${dim}(${currentLabel})${reset}\n`);

      const { select } = await import("../lib/rt-render.tsx");
      const action = await select({
        message: "What would you like to do?",
        options: [
          { value: "keep",   label: "Keep current setup",  hint: currentLabel },
          { value: "switch", label: "Switch mode",         hint: config.mode === "launchd" ? "→ background process" : "→ launchd agent" },
        ],
      });

      if (action === "keep") return;

      // Switch mode: uninstall then fall through to fresh install
      await uninstall();
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

  // Let user pick install mode
  let mode: DaemonMode;

  if (args.includes("--launchd")) {
    mode = "launchd";
  } else if (args.includes("--manual")) {
    mode = "manual";
  } else if (process.stdin.isTTY) {
    const { select } = await import("../lib/rt-render.tsx");
    mode = await select({
      message: "How should the daemon run?",
      options: [
        { value: "manual",  label: "Background process", hint: "start manually, no security prompts" },
        { value: "launchd", label: "launchd agent",      hint: "auto-starts on login, may trigger endpoint security" },
      ],
    }) as DaemonMode;
  } else {
    mode = "manual";
  }

  console.log("");

  const rtPath = resolveBunPath();
  const daemonScript = isCompiledBinary()
    ? undefined  // compiled: daemon is embedded, no script needed
    : resolve(new URL(import.meta.url).pathname, "../../lib/daemon.ts");

  if (!isCompiledBinary() && (!daemonScript || !existsSync(daemonScript))) {
    console.log(`  ${red}daemon script not found: ${daemonScript}${reset}\n`);
    process.exit(1);
  }

  // 1. Persist install config
  markDaemonInstalled(rtPath, daemonScript ?? "--daemon", mode);
  console.log(`  ${green}✓${reset} saved config to ~/.rt/daemon.json`);

  if (mode === "launchd") {
    // launchd mode: register plist
    const plist = generatePlist(rtPath, daemonScript);
    writeFileSync(LAUNCHD_PLIST_PATH, plist);
    console.log(`  ${green}✓${reset} created ${dim}${LAUNCHD_PLIST_PATH}${reset}`);

    try {
      try { execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" }); } catch { /* */ }
      execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`, { stdio: "pipe" });
      console.log(`  ${green}✓${reset} loaded launchd agent`);
    } catch (err) {
      console.log(`  ${red}✗${reset} failed to load launchd agent: ${err}`);
      console.log(`  ${dim}try manually: launchctl load "${LAUNCHD_PLIST_PATH}"${reset}\n`);
      return;
    }
  } else {
    // manual mode: spawn detached background process
    await spawnDaemonProcess(rtPath, daemonScript);
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
    const hint = mode === "launchd"
      ? "daemon will auto-start on login"
      : "run rt daemon start after reboot";
    console.log(`\n  ${green}${bold}✓ installed${reset} ${dim}— ${hint}${reset}\n`);
  } else {
    console.log(`  ${yellow}⚠${reset} daemon started but not yet responding`);
    console.log(`  ${dim}check logs: rt daemon logs${reset}\n`);
  }
}

async function spawnDaemonProcess(rtPath?: string, daemonScript?: string): Promise<void> {
  const config = getDaemonConfig();
  const bin = rtPath || config?.bunPath || "bun";
  const script = daemonScript || config?.daemonScript;

  // Determine spawn args: compiled binary uses `rt --daemon`, source uses `bun run <script>`
  const compiled = isCompiledBinary() || !script || script === "--daemon";
  const spawnArgs = compiled ? ["--daemon"] : ["run", script!];

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

  // 1. Graceful shutdown via socket
  const response = await daemonQuery("shutdown");
  if (response?.ok) {
    console.log(`  ${green}✓${reset} daemon stopped gracefully`);
    await Bun.sleep(200);
  } else if (isDaemonProcessRunning()) {
    // Force kill if socket didn't work
    const pid = readDaemonPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  ${green}✓${reset} daemon stopped (SIGTERM)`);
        await Bun.sleep(200);
      } catch { /* already dead */ }
    }
  }

  // 2. Unload launchd plist
  if (existsSync(LAUNCHD_PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}"`, { stdio: "pipe" });
    } catch { /* */ }
    try {
      unlinkSync(LAUNCHD_PLIST_PATH);
    } catch { /* */ }
    console.log(`  ${green}✓${reset} removed launchd agent`);
  }

  // 3. Clear install flag
  markDaemonUninstalled();
  console.log(`  ${green}✓${reset} cleared install flag`);

  // 4. Clean up runtime files
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

  // ── Orphan detection ─────────────────────────────────────────────────────
  // A process is an "orphan" when it's alive (process exists) but its socket
  // is gone or unresponsive. This happens when the socket file is deleted by
  // a stop/restart but the process itself wasn't killed. Kill it so the new
  // instance can bind the socket cleanly.
  if (isDaemonProcessRunning()) {
    const pid = readDaemonPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  ${yellow}⚠${reset} evicted stale daemon process (pid ${pid}, socket was missing)`);
        await Bun.sleep(400);
      } catch { /* already dead */ }
    }
    // Remove any leftover runtime files so the new process starts clean
    for (const p of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* */ }
    }
  }

  const config = getDaemonConfig();

  if (config?.mode === "launchd") {
    try {
      execSync(`launchctl kickstart gui/$(id -u)/${LAUNCHD_LABEL}`, { stdio: "pipe" });
    } catch {
      console.log(`\n  ${red}failed to start via launchd${reset}`);
      console.log(`  ${dim}falling back to manual start…${reset}`);
      await spawnDaemonProcess();
    }
  } else {
    await spawnDaemonProcess();
  }

  // Give launchd slightly more time to settle than a manual spawn
  const waitMs = config?.mode === "launchd" ? 1500 : 600;
  await Bun.sleep(waitMs);

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
      process.kill(pid, 0); // throws if not alive
      await Bun.sleep(100);
    } catch {
      return true; // gone
    }
  }
  return false;
}

/** Remove socket + PID files (best-effort — called after any stop path). */
function cleanupRuntimeFiles(): void {
  for (const p of [DAEMON_SOCK_PATH, DAEMON_PID_PATH]) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
  }
}

export async function stop(): Promise<void> {
  const pidBefore = readDaemonPid();

  // 1. Try graceful shutdown via socket
  const response = await daemonQuery("shutdown");
  if (response?.ok) {
    // Daemon acknowledged — wait for the process to actually exit
    // (the daemon runs cleanup() then process.exit after a 100ms setTimeout)
    if (pidBefore) {
      const died = await waitForProcessDeath(pidBefore, 3000);
      if (!died) {
        // Graceful took too long — escalate to SIGKILL
        try { process.kill(pidBefore, "SIGKILL"); } catch { /* already dead */ }
      }
    } else {
      await Bun.sleep(300); // no PID on record — brief wait for socket cleanup
    }
    cleanupRuntimeFiles();
    console.log(`\n  ${green}✓ daemon stopped${reset}\n`);
    return;
  }

  // 2. Socket didn't respond — try SIGTERM via PID file
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
    console.log(`  ${dim}○${reset} not installed ${dim}(optional — run rt daemon install)${reset}\n`);
    return;
  }

  const response = await daemonQuery("status");
  if (response?.ok) {
    const { pid, uptime, watchedRepos, cacheEntries } = response.data;
    console.log(`  ${green}●${reset} running ${dim}(pid ${pid}, uptime ${formatUptime(uptime)})${reset}`);
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

