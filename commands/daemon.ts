#!/usr/bin/env bun

/**
 * rt daemon — Manage the rt background daemon.
 *
 * The daemon is an SMAppService LaunchAgent registered by the tray app. The agent
 * plist + daemon binary both live inside mattstack.app, and TCC attributes the
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

import { execSync, spawn, spawnSync } from "child_process";
import { basename, join } from "path";
import { reverseLookupByName } from "../lib/repo-arg.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { bold, dim, green, yellow, red, reset } from "../lib/tui.ts";
import {
  isDaemonInstalled,
  isDaemonProcessRunning,
  activeLaunchdLabel,
  markDaemonInstalled, markDaemonUninstalled, cleanupDaemonFiles,
  readDaemonPid,
  RT_DIR,
  LOG_DIR,
  LAUNCHD_PLIST_PATH,
} from "../lib/daemon-config.ts";
import { daemonQuery, isDaemonRunning, pingDaemon, trayQuery } from "../lib/daemon-client.ts";
import { classifyDaemonStatus, type DaemonStatusVerdict } from "../lib/daemon-status.ts";
import { resolveIntendedMode, currentMode, type IntendedMode } from "../lib/dev-mode.ts";
import { probeSocketHolder } from "../lib/daemon/park.ts";
import { readBreadcrumb, readSupervisionState } from "../lib/daemon/supervision-state.ts";
import { readHeartbeat } from "../lib/daemon/heartbeat-file.ts";
import { runCapture } from "../lib/subprocess.ts";
import { isGitLabRemote } from "../lib/enrich.ts";
import type { CacheKind, RepoTrackingEntry } from "../lib/repo-tracking.ts";
import { loadRepoTracking, loadMachineRepoTracking, loadMachineRepoTrackingRaw, saveRepoTrackingRaw, grants, parseCachesArg, CACHE_KINDS, DEFAULT_PROJECT_MRS_WINDOW_DAYS, teamNamesIdentity } from "../lib/repo-tracking.ts";
import { deriveRepoIdentity, parseIdentity, serializeIdentity } from "../lib/settings/identity.ts";
import { loadRepoIndex } from "../lib/repo-index.ts";
import { createProjectMRs } from "../lib/daemon/project-mrs-store.ts";
import { getStateDb } from "../lib/state/index.ts";
import { timeAgo } from "../lib/tui/utils/label.ts";
import { trayAppPath, installedTrayAppPath, devTrayAppPath, TRAY_APP_NAME, TRAY_APP_BUNDLE, tmpDir } from "../lib/rt-paths.ts";

/** Where to point an "open it" hint: the bundle's real install location if we can find one, else the conventional ~/Applications destination. */
function trayAppHintPath(): string {
  return installedTrayAppPath(TRAY_APP_BUNDLE) ?? trayAppPath();
}

// ─── Flavor identity ─────────────────────────────────────────────────────────

export interface FlavorTuple {
  intended: IntendedMode;
  cliFlavor: "dev" | "prod";
  daemon: { flavor: string; pid: number | null } | null;
}

export async function describeTuple(): Promise<FlavorTuple> {
  const holder = await probeSocketHolder();
  return { intended: resolveIntendedMode(), cliFlavor: currentMode(), daemon: holder };
}

/** Null when coherent OR when no daemon answers — a down daemon is a liveness problem, not a flavor mismatch. */
export function tupleWarning(t: FlavorTuple): string | null {
  if (!t.daemon) return null;
  if (t.daemon.flavor === t.intended.mode && t.cliFlavor === t.intended.mode) return null;
  const legs = `intended ${t.intended.mode} (${t.intended.provenance}) · CLI ${t.cliFlavor} · daemon ${t.daemon.flavor}${t.daemon.pid ? ` (pid ${t.daemon.pid})` : ""}`;
  return `flavor mismatch — ${legs}. Fix: rt settings dev-mode ${t.intended.mode}`;
}

/** Bundle to point an "open it" hint at: the intended flavor's, not necessarily the one the CLI itself is running. */
export function flavorHintPath(intended: IntendedMode): string {
  return intended.mode === "dev" ? devTrayAppPath() : trayAppHintPath();
}

/**
 * Shared copy for stop/start/restart's post-op flavor probe: the daemon that
 * answered on rt.sock isn't the flavor the operation targeted. `stop` wants
 * it gone; `start`/`restart` want their own flavor answering, so the verb
 * differs while the remedy doesn't.
 */
export function flavorMismatchLines(
  op: "stop" | "start" | "restart",
  holder: { flavor: string; pid: number | null },
  intendedMode: "dev" | "prod",
): [string, string] {
  const pidPart = holder.pid ? ` (pid ${holder.pid})` : "";
  const verb = op === "stop" ? "still holds" : "answered on";
  return [
    `a ${holder.flavor} daemon ${verb} rt.sock${pidPart}, not ${intendedMode}`,
    `Fix: rt settings dev-mode ${intendedMode}`,
  ];
}

/** stop's holder-still-present case when the holder is its OWN flavor: not a mismatch, just a slow shutdown. */
export function stillShuttingDownLine(holder: { pid: number | null }): string {
  return `still shutting down — give it a moment${holder.pid ? ` (pid ${holder.pid})` : ""}`;
}

/** Prints stop/start/restart's mismatch warning in the shared two-line shape. */
function printFlavorMismatch(op: "stop" | "start" | "restart", holder: { flavor: string; pid: number | null }, intendedMode: "dev" | "prod"): void {
  const [headline, remedy] = flavorMismatchLines(op, holder, intendedMode);
  console.log(`\n  ${yellow}⚠ ${headline}${reset}`);
  console.log(`  ${dim}${remedy}${reset}\n`);
}

/**
 * start/restart's post-liveness flavor check. Any holder flavor other than
 * the intended one is worth a warning — including "unknown flavor", since the
 * daemon that was just (re)started should be answering with real identity.
 * Returns true when it printed the warning, so the caller skips the plain ✓.
 */
async function warnIfWrongFlavor(op: "start" | "restart", intended: IntendedMode): Promise<boolean> {
  const holder = await probeSocketHolder();
  if (!holder || holder.flavor === intended.mode) return false;
  printFlavorMismatch(op, holder, intended.mode);
  return true;
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
  const intended = resolveIntendedMode();
  console.log(`  ${dim}registering the ${intended.mode} daemon${reset}`);

  // Persist the install marker so isDaemonInstalled() returns true and the
  // CLI will attempt to reach the daemon (rather than silently no-op).
  markDaemonInstalled();
  console.log(`  ${green}✓${reset} saved config to ~/.mattstack/rt/daemon.json`);

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
    console.log(`  ${yellow}⚠${reset} ${TRAY_APP_NAME} not reachable — open it to finish setup`);
    console.log(`  ${dim}  ${bold}open ${flavorHintPath(intended)}${reset}`);
  }

  // Wait for daemon to come online
  let connected = false;
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(250);
    if (await isDaemonRunning()) { connected = true; break; }
  }

  if (connected) {
    console.log(`  ${green}✓${reset} daemon is running`);
    console.log(`\n  ${green}${bold}✓ installed${reset} ${dim}— managed by ${TRAY_APP_NAME} · launchd-supervised · TCC inherits from ${TRAY_APP_BUNDLE}${reset}\n`);
  } else {
    // Query the tray to find out WHY the daemon isn't responding
    const trayStatus = await trayQuery("/daemon/status", "GET");
    const smStatus = trayStatus?.ok ? (trayStatus as any).status : "unknown";

    console.log(`  ${yellow}⚠${reset} daemon not yet responding`);

    if (smStatus === "requiresApproval") {
      console.log(`  ${dim}macOS requires approval to run the background service.${reset}`);
      console.log(`  ${dim}Opening System Settings → Login Items — click ${bold}Allow${reset}${dim} next to ${TRAY_APP_NAME}.${reset}`);
      console.log(`  ${dim}Then run: ${bold}rt daemon start${reset}\n`);
      try { execSync("open 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'", { stdio: "pipe" }); } catch { /* */ }
    } else if (smStatus === "notFound") {
      console.log(`  ${red}✗${reset} daemon binary not found inside ${TRAY_APP_BUNDLE}`);
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

  // 3. A failed/absent tray stop must never delete rt.sock/rt.pid/daemon.json
  // out from under a daemon that's actually still alive (that would orphan
  // it, still running, launchd-supervised, but rt's own bookkeeping says
  // uninstalled). Check both liveness signals: the recorded pid, and whether
  // anything still answers on rt.sock (a daemon can be alive with no
  // matching rt.pid, e.g. after a crash-and-respawn under launchd).
  const stillAlive = isDaemonProcessRunning() || (await probeSocketHolder()) !== null;
  if (stillAlive) {
    console.log(`\n  ${yellow}⚠${reset} daemon is still running, leaving rt.sock/rt.pid/daemon.json in place`);
    console.log(`  ${dim}Fix: ${bold}launchctl bootout gui/$UID/${activeLaunchdLabel()}${reset}\n`);
    return;
  }

  // 4. Clear install flag + sock/pid files.
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

  const intended = resolveIntendedMode();

  if (await isDaemonRunning()) {
    if (!(await warnIfWrongFlavor("start", intended))) {
      console.log(`\n  ${green}daemon is already running${reset}\n`);
    }
    return;
  }

  const result = await trayQuery("/daemon/start", "POST");
  if (!result?.ok) {
    console.log(`\n  ${yellow}${TRAY_APP_NAME} is not running${reset}`);
    console.log(`  ${dim}open it: ${bold}open ${flavorHintPath(intended)}${reset}\n`);
    return;
  }

  console.log(`  ${dim}starting ${intended.mode} daemon via tray…${reset}`);
  if (await pollForDaemonUp(intended)) return;

  // The tray acked /daemon/start, but SMAppService can register a job that
  // never actually launches (still booting, crash-looping, etc.); kick it
  // via /daemon/restart, which forces launchd to invoke it, rather than
  // leaving the operator staring at "check logs" for something a retry fixes.
  console.log(`  ${dim}not up yet, escalating to restart (kickstart)…${reset}`);
  const restartResult = await trayQuery("/daemon/restart", "POST");
  if (restartResult?.ok && (await pollForDaemonUp(intended))) return;

  console.log(`\n  ${yellow}daemon starting… check logs: rt daemon logs${reset}\n`);
}

/** Shared poll loop for start()'s initial wait and its kickstart escalation. */
async function pollForDaemonUp(intended: IntendedMode): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(250);
    if (await isDaemonRunning()) {
      if (!(await warnIfWrongFlavor("start", intended))) {
        console.log(`\n  ${green}✓ daemon started${reset}\n`);
      }
      return true;
    }
  }
  return false;
}

export async function stop(): Promise<void> {
  const intended = resolveIntendedMode();
  const result = await trayQuery("/daemon/stop", "POST");
  if (result?.ok) {
    await Bun.sleep(500);
    // The ack only proves the reached tray's OWN flavor was told to stop —
    // rt.sock is shared, so a different-flavor daemon can still hold it.
    const holder = await probeSocketHolder();
    if (holder) {
      // Compare against the intended flavor (the leg this stop addressed), not
      // the CLI wrapper's own currentMode() — a stale wrapper mid-flip would
      // otherwise report a mismatch against a daemon that's just slow to exit.
      if (holder.flavor === intended.mode) {
        console.log(`\n  ${yellow}⚠ ${stillShuttingDownLine(holder)}${reset}\n`);
        return;
      }
      printFlavorMismatch("stop", holder, intended.mode);
      return;
    }
    console.log(`\n  ${green}✓ ${intended.mode} daemon stopped${reset}\n`);
    return;
  }
  console.log(`\n  ${yellow}${TRAY_APP_NAME} is not running — nothing to stop${reset}\n`);
}

export async function restart(): Promise<void> {
  const intended = resolveIntendedMode();
  const result = await trayQuery("/daemon/restart", "POST");
  if (!result?.ok) {
    console.log(`\n  ${yellow}${TRAY_APP_NAME} is not running${reset}`);
    console.log(`  ${dim}open it: ${bold}open ${flavorHintPath(intended)}${reset}\n`);
    return;
  }
  console.log(`  ${dim}restarting ${intended.mode} daemon via tray…${reset}`);
  for (let i = 0; i < 16; i++) {
    await Bun.sleep(500);
    if (await isDaemonRunning()) {
      if (!(await warnIfWrongFlavor("restart", intended))) {
        console.log(`\n  ${green}✓ daemon restarted${reset}\n`);
      }
      return;
    }
  }
  console.log(`\n  ${yellow}daemon restarting… check logs: rt daemon logs${reset}\n`);
}

// ─── Status ──────────────────────────────────────────────────────────────────

/**
 * Raw OS-level liveness, independent of rt.sock. Tries a direct pid check
 * first against every pid this HOME actually recorded: rt.pid, then the
 * boot breadcrumb's pid (the breadcrumb survives failures rt.pid never gets
 * written for, per Ruling P1), before falling back to a last-resort scan.
 *
 * That scan is `lsof +D <RT_DIR>`, not the brief's suggested system-wide
 * `pgrep -f 'rt --daemon|lib/daemon.ts'`: a raw pgrep matches ANY rt daemon
 * on the machine regardless of which HOME started it, and on an ordinary dev
 * workstation there usually IS one (the developer's own real daemon), so a
 * pgrep-based check on an isolated/alternate HOME reliably misreports a dead
 * boot attempt as alive-not-serving (verified live against this repo's own
 * dev daemon while writing the e2e test below). `lsof +D` instead asks "does
 * any process hold a file open under THIS HOME's rt dir", home-scoped by
 * construction, immune to that false positive and to pid-reuse. Only worth
 * calling once both `status` and a plain ping have already failed.
 *
 * The CALLER itself is excluded from the lsof result: `showStatus` opens its
 * own `bun:sqlite` handle on `state.db` (inside RT_DIR) via
 * `readSupervisionState()` just before this probe runs, so `lsof +D RT_DIR`
 * legitimately reports the calling CLI process as a live holder of the
 * directory, with no daemon involved at all. Left unfiltered, a genuinely
 * dead daemon self-matches and misclassifies as alive-not-serving/parked;
 * this only failed to show up in manual testing because incidental work
 * happened to separate the state.db open from the lsof call by enough time
 * for state.db's own transient lock window to close, an accident of
 * timing, not a guarantee.
 */
export async function probePidAlive(recordedPid: number | null, breadcrumbPid?: number): Promise<{ alive: boolean; pid: number | null }> {
  for (const candidate of [recordedPid, breadcrumbPid ?? null]) {
    if (candidate === null) continue;
    try {
      process.kill(candidate, 0);
      return { alive: true, pid: candidate };
    } catch { /* not this one, try the next candidate */ }
  }
  const { stdout } = await runCapture(["lsof", "-t", "+D", RT_DIR], { timeoutMs: 3000 });
  const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number)
    .filter((n) => !isNaN(n) && n !== process.pid);
  return pids.length > 0 ? { alive: true, pid: pids[0]! } : { alive: false, pid: recordedPid };
}

export async function showStatus(args: string[] = []): Promise<void> {
  const json = args.includes("--json");

  if (!isDaemonInstalled()) {
    if (json) return void console.log(JSON.stringify({ ok: true, state: "not-installed" }));
    console.log(`  ${dim}○${reset} not installed ${dim}(run rt daemon install)${reset}\n`);
    return;
  }

  const response = await daemonQuery("status");
  // A failed status query does NOT mean the daemon is down — it answers `ping`
  // in a fraction of the budget a loaded `status` needs. Establish liveness
  // before reporting, and only pay for the probe when nothing came back.
  // pingDaemon (not isDaemonRunning) so the raw reply's eventLoop summary is
  // still on hand to render, and so this probe never risks a restart.
  const pingResp = classifyDaemonStatus.needsLivenessProbe(response) ? await pingDaemon() : null;
  const pingOk = pingResp?.ok === true;
  const recordedPid = readDaemonPid() ?? null;

  // Ping ALSO failed: the only remaining ground is the pid/breadcrumb/kv/heartbeat
  // trail Task 9/2 left behind. Read it here, once, rather than on every status
  // call, since it's the uncommon path.
  let pidAlive: boolean | undefined;
  let pid = recordedPid;
  let breadcrumb: ReturnType<typeof readBreadcrumb> | undefined;
  let supervision: ReturnType<typeof readSupervisionState> | undefined;
  let heartbeat: ReturnType<typeof readHeartbeat> | undefined;
  if (classifyDaemonStatus.needsPidProbe(response, pingOk)) {
    breadcrumb = readBreadcrumb();
    // The kv tier can be legitimately empty (or reflect nothing useful) when
    // a failure happened before state.db ever opened (Ruling P1). The
    // breadcrumb read above is what classifyDaemonStatus falls back to then.
    supervision = readSupervisionState();
    heartbeat = readHeartbeat(RT_DIR);
    const probed = await probePidAlive(recordedPid, breadcrumb?.pid);
    pidAlive = probed.alive;
    pid = probed.pid;
  }

  const verdict = classifyDaemonStatus({
    installed: true,
    response,
    pingOk,
    pid,
    pidAlive,
    intendedFlavor: resolveIntendedMode().mode,
    breadcrumb,
    supervision,
    heartbeat,
    pingEventLoop: (pingResp as any)?.eventLoop,
  });

  if (json) return void console.log(JSON.stringify({ ok: true, ...verdict }));

  for (const line of statusLines(verdict, Date.now())) console.log(line);

  if (verdict.state === "running") {
    // `status`'s reply, already fetched above, carries `data.identity` — reuse
    // it rather than a second probeSocketHolder() round-trip.
    const identity = verdict.data.identity as
      | { flavor: "dev" | "prod"; version: string; sourceRev: string | null }
      | undefined;
    if (identity) {
      printFlavorInfo({ flavor: identity.flavor, version: identity.version, sourceRev: identity.sourceRev, pid: verdict.data.pid ?? null });
    }
    // S077: a declared pool this machine has never opted into (unowned default
    // is now disabled) would otherwise build nothing with no visible reason.
    const worktreePool = verdict.data.worktreePool as { dormant: boolean; message?: string } | undefined;
    if (worktreePool?.dormant) {
      console.log(`    ${dim}${worktreePool.message}${reset}`);
    }
  } else if (verdict.state === "degraded") {
    // `status` timed out or errored, but the daemon proved it's alive — the
    // flavor cross-check matters most right here, so it earns its own ping.
    printFlavorInfo(await probeSocketHolder());
  }

  console.log(`    ${dim}config: ~/.mattstack/rt/daemon.json${reset}`);
  console.log(`    ${dim}logs: ~/.mattstack/rt/logs/ ${reset}${dim}(view with: rt daemon logs)${reset}`);
  console.log("");
}

/** Renders from whatever identity the caller has on hand — full ping/status data, or just a probeSocketHolder() flavor+pid. */
function printFlavorInfo(daemon: { flavor: string; pid: number | null; version?: string; sourceRev?: string | null } | null): void {
  if (!daemon) return;
  const rev = daemon.flavor === "dev" && daemon.sourceRev ? ` (${daemon.sourceRev})` : "";
  const versionPart = daemon.version ? ` · ${daemon.version}${rev}` : "";
  console.log(`    ${dim}${daemon.flavor}${versionPart}${reset}`);

  const tuple: FlavorTuple = {
    intended: resolveIntendedMode(),
    cliFlavor: currentMode(),
    daemon: { flavor: daemon.flavor, pid: daemon.pid },
  };
  const warning = tupleWarning(tuple);
  if (warning) console.log(`    ${yellow}⚠${reset} ${warning}`);
}

/**
 * Render a verdict to the lines the operator reads. Pure — `now` is injected so
 * the freshness ages are deterministic under test.
 */
export function statusLines(verdict: DaemonStatusVerdict, now: number): string[] {
  if (verdict.state === "running") {
    const { pid, uptime, watchedRepos, cacheEntries } = verdict.data;
    const lines = [
      `  ${green}●${reset} running ${dim}(SMAppService · pid ${pid} · uptime ${formatUptime(uptime)})${reset}`,
      `    ${dim}watching: ${watchedRepos} repo${watchedRepos !== 1 ? "s" : ""}${reset}`,
      `    ${dim}cache: ${cacheEntries} entries${reset}`,
    ];

    const freshness = verdict.data.freshness as
      | Record<string, { state: string; lastSyncedAt: string | null }>
      | undefined;
    if (freshness && Object.keys(freshness).length > 0) {
      const parts = Object.entries(freshness).map(([repo, f]) => {
        // lastSyncedAt only advances on a non-empty batch or a state
        // transition, so a quiet-but-healthy repo can go the whole session
        // without one; "never" would misread as broken, not idle.
        const age = f.lastSyncedAt
          ? `${Math.round((now - Date.parse(f.lastSyncedAt)) / 1000)}s ago`
          : "no events yet";
        return `${repo} ${f.state} (${age})`;
      });
      lines.push(`    ${dim}events: ${parts.join(" · ")}${reset}`);
    }

    const health = verdict.data.health as { level: string; reasons: string[] } | undefined;
    if (health && health.level !== "ok") {
      const dot = health.level === "unhealthy" ? red : yellow;
      lines.push(`    ${dot}health: ${health.level}${reset}`);
      for (const r of health.reasons) lines.push(`      ${dim}- ${r}${reset}`);
    }
    const el = verdict.data.eventLoop as { maxLagMs: number } | undefined;
    if (el && el.maxLagMs >= 500) lines.push(`    ${dim}event loop: maxLag ${el.maxLagMs}ms${reset}`);
    return lines;
  }

  if (verdict.state === "degraded") {
    // Up, but `status` did not come back. Saying "not running" here would send
    // the operator to `rt daemon start` against a daemon that is already up.
    const lines = [`  ${yellow}●${reset} running, but not reporting status`];
    if (verdict.pid) lines.push(`    ${dim}pid: ${verdict.pid}${reset}`);
    if (verdict.reason === "error") {
      lines.push(`    ${dim}status command failed: ${verdict.detail ?? "unknown error"}${reset}`);
    } else if (verdict.eventLoop && verdict.eventLoop.maxLagMs > 0) {
      const el = verdict.eventLoop;
      lines.push(`    ${dim}answers ping, status timed out: event loop maxLag ${el.maxLagMs}ms${el.lastStallCmd ? ` (last stall in ${el.lastStallCmd})` : ""}${reset}`);
    } else {
      lines.push(`    ${dim}answers ping, but status timed out — likely mid-sync${reset}`);
    }
    lines.push(`    ${dim}check: rt daemon logs${reset}`);
    return lines;
  }

  if (verdict.state === "parked") {
    const lines = [`  ${yellow}◐${reset} parked ${dim}(pid ${verdict.pid}, another flavor owns rt.sock)${reset}`];
    lines.push(
      verdict.holderFlavor
        ? `    ${dim}held by: ${verdict.holderFlavor}${reset}`
        : `    ${dim}waiting for the intended flavor to take rt.sock${reset}`,
    );
    lines.push(`    ${dim}check: rt settings dev-mode${reset}`);
    return lines;
  }

  if (verdict.state === "alive-not-serving") {
    const detailLine = {
      booting: "still booting",
      wedged: "reached ready but stopped answering (likely deadlocked)",
      quarantined: "recovered from a corrupt db but still not answering",
      stalled: `event loop stalled ${Math.round((verdict.stalledForMs ?? 0) / 1000)}s ago (no heartbeat)`,
    }[verdict.detail];
    return [
      `  ${yellow}●${reset} process ${verdict.pid} is running but not answering rt.sock`,
      `    ${dim}${detailLine}${reset}`,
      `    ${dim}check: rt daemon logs -t${reset}`,
    ];
  }

  if (verdict.state === "crash-looping") {
    return [
      `  ${red}●${reset} crash-looping ${dim}(${verdict.failures} failures recently)${reset}`,
      `    ${dim}last reason: ${verdict.reason}${reset}`,
      `    ${dim}check: rt daemon logs -t${reset}`,
    ];
  }

  if (verdict.state === "boot-failed") {
    return [
      `  ${red}●${reset} boot failed ${dim}(phase: ${verdict.phase})${reset}`,
      `    ${dim}reason: ${verdict.reason}${reset}`,
      `    ${dim}run: rt daemon start${reset}`,
    ];
  }

  if (verdict.state === "not-running") {
    const lines = [`  ${red}●${reset} installed but not running`];
    if (verdict.pid) lines.push(`    ${dim}last pid: ${verdict.pid}${reset}`);
    lines.push(`    ${dim}run: rt daemon start${reset}`);
    return lines;
  }

  return [];
}

// ─── Per-repo tracking (opt-in) ──────────────────────────────────────────────

/** "45d" for an explicit value, "(default 30)" when the entry leaves it unset. */
function formatWindowLabel(rawWindowDays: number | undefined): string {
  return rawWindowDays !== undefined ? `${rawWindowDays}d` : `(default ${DEFAULT_PROJECT_MRS_WINDOW_DAYS})`;
}

function readRepoIndex(): Record<string, string> {
  return loadRepoIndex();
}

/** A raw serialized identity → its display label (last path segment / basename). */
function trackingLabel(serialized: string): string {
  const id = parseIdentity(serialized);
  if (!id) return serialized;
  return id.kind === "remote" ? (id.id.split("/").pop() ?? id.id) : basename(id.id);
}

/**
 * Resolve the operator's `rt daemon track <arg>` argument — an already-serialized
 * identity, a directory path, or a bare repo name — to the serialized identity
 * every store keys on, plus the checkout path when one is known. Null when a
 * name matches no registered repo (or is ambiguous); `path` is null only when
 * an identity was typed for a repo absent from the index.
 */
async function resolveTrackingIdentity(arg: string): Promise<{ identity: string; path: string | null } | null> {
  const index = readRepoIndex();
  if (parseIdentity(arg)) return { identity: arg, path: index[arg] ?? null };
  try {
    if (statSync(arg).isDirectory()) {
      return { identity: serializeIdentity(await deriveRepoIdentity(arg)), path: arg };
    }
  } catch { /* not a directory on disk — fall through to the name reverse-lookup */ }
  const matches = reverseLookupByName(arg, index);
  if (matches.length === 1) return { identity: matches[0]![0], path: matches[0]![1] };
  return null;
}

/**
 * Manage per-repo background tracking.
 *
 *   rt daemon track                      list repos with level + watcher state
 *   rt daemon track <repo> live|poll     events watcher + 5-min enrichment (branches by default)
 *   rt daemon track <repo> off           no background API calls (default)
 *   rt daemon track <repo> live|poll <caches>  opt-in to specific caches (branches,project-mrs,discussions)
 *
 * "off" removes the entry (off is the default for unlisted repos) — UNLESS
 * the team layer (`mattstack.tracking`) still names this repo, in which case
 * a bare delete would let team intent resurrect it on the next merged read;
 * "off" then plants an explicit `{mode:"off"}` marker instead, a real local
 * opt-out (see lib/repo-tracking.ts's module doc). Level changes apply
 * immediately for watchers; the 5-min poll picks up poll/off changes on its
 * next cycle, so `live`/`poll` also kick a refresh.
 */
export async function manageTracking(args: string[] = []): Promise<void> {
  const [repoArg, levelArg] = args;

  if (!repoArg) {
    const repos = readRepoIndex();
    const tracking = loadRepoTracking();
    const status = await daemonQuery("status");
    const freshness = ((status?.ok ? status.data?.freshness : undefined) ?? {}) as
      Record<string, { state: string }>;

    console.log(`\n  ${bold}repo tracking${reset} ${dim}(opt-in · rt.repoTracking · unlisted = off)${reset}\n`);
    for (const identity of Object.keys(repos).sort()) {
      const g = grants(tracking, identity);
      const watcher = freshness[identity];
      const label = trackingLabel(identity);
      const marker = g.mode === "live" ? `${green}●${reset}` : g.mode === "poll" ? `${yellow}◐${reset}` : `${dim}○${reset}`;
      const detail = g.mode === "live"
        ? `live${watcher ? ` (${watcher.state})` : " (watcher starting)"}`
        : g.mode === "poll" ? "poll" : "";
      const suffix = g.mode === "off" ? "" : ` [${[...g.caches].join(", ")}] window ${formatWindowLabel(tracking[identity]?.projectMrsWindowDays)}`;
      console.log(`  ${marker} ${g.mode === "off" ? `${dim}${label}${reset}` : label}${detail ? ` ${dim}${detail}${reset}` : ""}${suffix ? ` ${dim}${suffix}${reset}` : ""}`);
    }
    // Tracking entries that no longer match a registered repo do nothing;
    // surface them so a rename or typo isn't silently inert.
    for (const identity of Object.keys(tracking).filter((n) => !repos[n])) {
      console.log(`  ${yellow}!${reset} ${trackingLabel(identity)} ${dim}(tracked but not in ~/.mattstack/rt/repos.json)${reset}`);
    }
    console.log(`\n  ${dim}set: rt daemon track <repo> live|poll|off [caches]   caches: ${[...CACHE_KINDS].join(",")} (default branches)${reset}\n`);
    return;
  }

  // Every store keys on the serialized identity now; resolve the operator's
  // argument (name, path, or identity) to it once. Human-facing messages keep
  // showing what they typed (`repoArg`).
  const resolved = await resolveTrackingIdentity(repoArg);

  // ── rt daemon track <repo> — interactive editor (house style: fzf flow) ──
  let interactiveLevel: string | undefined;
  let interactiveCaches: CacheKind[] | undefined;
  let interactiveWindowDays: number | null | undefined; // undefined = untouched, null = clear
  if (!levelArg) {
    if (!resolved) {
      console.log(`\n  ${red}✗${reset} repo "${repoArg}" not registered in ~/.mattstack/rt/repos.json\n`);
      return;
    }
    const identity = resolved.identity;
    const { filterableSelect, filterableMultiselect } = await import("../lib/pick-wrappers.ts");
    const { textInput } = await import("../lib/rt-render.ts");
    const displayTracking = loadRepoTracking();
    const rawEntry = displayTracking[identity];
    const current = grants(displayTracking, identity);
    const modeHint = (m: string) => (current.mode === m ? "current" : undefined);

    console.log(`\n  ${bold}${repoArg}${reset} ${dim}window ${formatWindowLabel(rawEntry?.projectMrsWindowDays)}${reset}`);
    // Read-only: the store is written only by the daemon (deep sync,
    // registerDemand), never by the CLI. CLI-side construction (spec
    // "Store-by-store" item 2) — explicit cli-flavor db handle, since
    // createProjectMRs' own default targets the daemon-flavor connection.
    const demands = createProjectMRs(getStateDb()).read(identity)?.demands;
    if (demands && Object.keys(demands).length > 0) {
      console.log(`  ${dim}demands (read-only):${reset}`);
      for (const [client, d] of Object.entries(demands)) {
        console.log(`    ${dim}${client} · ${d.authors.length} author${d.authors.length === 1 ? "" : "s"} [${d.authors.join(", ")}] · last seen ${timeAgo(d.lastSeenAt)}${reset}`);
      }
    }

    const picked = await filterableSelect({
      message: `${repoArg} tracking mode`,
      options: [
        { value: "live", label: "live", hint: [modeHint("live"), "events watcher (~15s) + 5-min cycle · GitLab only"].filter(Boolean).join(" · ") },
        { value: "poll", label: "poll", hint: [modeHint("poll"), "5-min cycle only"].filter(Boolean).join(" · ") },
        { value: "off",  label: "off",  hint: [modeHint("off"), "no background API calls (on-demand still works)"].filter(Boolean).join(" · ") },
      ],
    });
    if (!picked) return; // esc = no changes
    interactiveLevel = picked;
    if (picked !== "off") {
      const selected = await filterableMultiselect({
        message: `${repoArg} caches — space to toggle, enter to confirm`,
        options: [
          { value: "branches",    label: "branches",    hint: "my branches: MR + Linear enrichment" },
          { value: "project-mrs", label: "project-mrs", hint: "team-wide open-MR list (boards)" },
          { value: "discussions", label: "discussions", hint: "background thread freshness + comment notifications" },
        ],
        initialValues: current.mode === "off" ? ["branches"] : [...current.caches],
      });
      if (selected === null) return; // esc = no changes
      if (selected.length === 0) {
        console.log(`\n  ${red}✗${reset} at least one cache is required ${dim}(use off to stop tracking)${reset}\n`);
        return;
      }
      interactiveCaches = selected as CacheKind[];

      // Positive integer or empty (clears back to default); re-prompt on
      // anything else rather than silently keeping a bad value.
      while (true) {
        const raw = await textInput({
          message: `project-mrs window in days (empty clears to default ${DEFAULT_PROJECT_MRS_WINDOW_DAYS})`,
          defaultValue: rawEntry?.projectMrsWindowDays !== undefined ? String(rawEntry.projectMrsWindowDays) : "",
        });
        const trimmed = raw.trim();
        if (trimmed === "") { interactiveWindowDays = null; break; }
        const n = Number(trimmed);
        if (Number.isInteger(n) && n > 0) { interactiveWindowDays = n; break; }
        console.log(`  ${red}✗${reset} enter a positive integer, or leave empty to clear`);
      }
    }
  }

  const level = interactiveLevel ?? levelArg;
  if (!level || !["live", "poll", "off"].includes(level)) {
    console.log(`\n  usage: rt daemon track [<repo>] [live|poll|off [caches…]]\n         <repo> alone opens the interactive editor\n         caches: ${[...CACHE_KINDS].join(" ")} (space-separated; default branches)\n`);
    return;
  }
  const levelArg2 = level;

  // Explicit caches: everything after the level, space-separated words
  // (commas tolerated for muscle memory).
  const cachesArg = interactiveCaches ? undefined : (args.length > 2 ? args.slice(2).join(",") : undefined);
  let caches: CacheKind[] = interactiveCaches ?? ["branches"];
  if (!interactiveCaches && levelArg2 !== "off" && cachesArg !== undefined) {
    const parsed = parseCachesArg(cachesArg);
    if (!parsed) {
      console.log(`\n  ${red}✗${reset} unknown cache name in "${args.slice(2).join(" ")}" ${dim}(valid: ${[...CACHE_KINDS].join(", ")})${reset}\n`);
      return;
    }
    caches = parsed;
  }

  if (levelArg2 !== "off") {
    const repoPath = resolved?.path ?? null;
    if (!repoPath) {
      console.log(`\n  ${red}✗${reset} repo "${repoArg}" not registered in ~/.mattstack/rt/repos.json\n`);
      return;
    }
    if (levelArg2 === "live") {
      // Watchers only ever start for GitLab remotes; refuse rather than
      // write a tracking entry that can never take effect.
      let remoteUrl = "";
      try {
        remoteUrl = execSync("git config --get remote.origin.url", {
          cwd: repoPath, encoding: "utf8", stdio: "pipe",
        }).trim();
      } catch { /* no origin remote */ }
      if (!isGitLabRemote(remoteUrl)) {
        console.log(`\n  ${red}✗${reset} ${repoArg} has no GitLab remote ${dim}(${remoteUrl || "no origin"})${reset}; live watching is GitLab-only (use poll)\n`);
        return;
      }
    }
  }

  // `previousEntry` only ever feeds the window/caches-reset bookkeeping below,
  // which only cares about valid live/poll entries, so the NORMALIZED view is
  // fine for it. The WRITE itself must start from the RAW map instead:
  // loadMachineRepoTracking() drops any entry normalizeEntry rejects — a
  // typo'd mode, or another repo's explicit {mode:"off"} opt-out marker — so
  // rebuilding the whole store from it would silently erase that marker the
  // moment ANY repo's tracking is next written (the bug the rider fixes). A
  // merged (loadRepoTracking) read must never be the base either — that would
  // bake every other repo's team-synthesized entry into the machine store as
  // if a human had granted it.
  const tracking = loadMachineRepoTracking();
  const rawTracking = loadMachineRepoTrackingRaw();
  // Falls back to the literal argument only when a stale-entry `off` names a
  // repo no longer in the index (nothing to derive an identity from); every
  // resolvable path keys by the serialized identity.
  const writeKey = resolved?.identity ?? repoArg;
  const previousEntry = levelArg2 !== "off" ? tracking[writeKey] : undefined;
  let offMarker = false;
  let newEntry: RepoTrackingEntry | undefined;
  if (levelArg2 === "off") {
    delete rawTracking[writeKey];
    // A repo the team layer still declares intent for needs a raw-named
    // block, not a bare delete — otherwise the merge in loadRepoTracking
    // resurrects team intent for it on the very next read.
    if (resolved && teamNamesIdentity(resolved.identity)) {
      rawTracking[resolved.identity] = { mode: "off" };
      offMarker = true;
    }
  } else {
    // Only the interactive editor ever touches the window; the positional
    // CLI form (rt daemon track <repo> live [caches]) carries whatever the
    // entry it's replacing already had.
    const windowDays = interactiveWindowDays !== undefined
      ? (interactiveWindowDays ?? undefined)
      : previousEntry?.projectMrsWindowDays;
    newEntry = {
      mode: levelArg2 as "live" | "poll",
      caches,
      ...(windowDays !== undefined ? { projectMrsWindowDays: windowDays } : {}),
    };
    rawTracking[writeKey] = newEntry;
  }
  saveRepoTrackingRaw(rawTracking);
  console.log(`\n  ${green}✓${reset} ${repoArg} tracking: ${levelArg2}${levelArg2 === "off" ? "" : ` [${caches.join(", ")}] window ${formatWindowLabel(newEntry?.projectMrsWindowDays)}`}`);
  if (offMarker) {
    console.log(`    ${dim}${repoArg} is still team-tracked — recorded as a local opt-out (rt daemon track ${repoArg} live to re-enable)${reset}`);
  }
  // A write that omits the caches arg always resets to ["branches"] (see
  // default above). If the entry it replaced granted more than that, the
  // caller silently lost project-mrs/discussions grants — flag it.
  if (
    levelArg2 !== "off" &&
    interactiveCaches === undefined &&
    cachesArg === undefined &&
    previousEntry &&
    previousEntry.caches.some((c) => c !== "branches")
  ) {
    console.log(`    ${dim}note: caches reset to [branches] (was [${previousEntry.caches.join(", ")}]) — pass a caches list to keep grants${reset}`);
  }

  // Watchers apply immediately; a fresh enrichment pass makes poll/live
  // repos show data now instead of at the next 5-minute cycle.
  const res = await daemonQuery("freshness:reconcile", undefined, 30_000);
  if (res?.ok) {
    const watching = Object.keys((res.data ?? {}) as Record<string, unknown>).map(trackingLabel).sort();
    console.log(`    ${dim}live watchers: ${watching.length > 0 ? watching.join(", ") : "none"}${reset}`);
    if (levelArg2 !== "off") await daemonQuery("cache:refresh");
    console.log("");
  } else {
    console.log(`    ${dim}daemon not reachable; applies when it next starts or refreshes${reset}\n`);
  }
}

// ─── Logs ────────────────────────────────────────────────────────────────────

/**
 * Decides whether showLogs' native-stderr block is worth printing, and its
 * header. `daemon-stderr.log` is rotated on open (daemon-logger.ts) but the
 * fresh file can still be non-empty from a crash that happened before *this*
 * boot's rotation ran (e.g. a bun panic mid-startup), so staleness is judged
 * by mtime vs. the live daemon's startedAt, not by rotation alone. A `null`
 * startedAt (daemon unreachable, nothing to compare against) fails open:
 * show it, since a down daemon is exactly when the last crash matters most.
 */
export function nativeStderrDisplay(
  mtimeMs: number,
  daemonStartedAt: number | null,
): { show: boolean; header: string } {
  if (daemonStartedAt !== null && mtimeMs <= daemonStartedAt) {
    return { show: false, header: "no crash since this daemon started" };
  }
  return { show: true, header: `native stderr (captured ${new Date(mtimeMs).toISOString()})` };
}

/**
 * Show daemon logs.
 *
 *   rt daemon logs              → open browser-based viewer (logdy)
 *   rt daemon logs --terminal   → live tail piped through pino-pretty
 *   rt daemon logs -t           → same as --terminal
 */
export async function showLogs(args: string[] = []): Promise<void> {
  const terminal = args.includes("--terminal") || args.includes("-t");

  if (!existsSync(LOG_DIR)) {
    console.log(`\n  ${dim}no daemon logs yet — start the daemon first${reset}\n`);
    return;
  }

  // Surface captured native stderr first — these are bun panics/asserts that
  // bypassed the JS-side interceptor and were caught by the swift-shim's
  // freopen of fd 2. Only shown when it postdates the running daemon's boot,
  // otherwise it's a previous life's crash, not "the most recent crash".
  const stderrPath = join(LOG_DIR, "daemon-stderr.log");
  if (existsSync(stderrPath)) {
    const content = readFileSync(stderrPath, "utf8").trim();
    if (content) {
      const mtimeMs = statSync(stderrPath).mtimeMs;
      const ping = await daemonQuery("ping");
      const daemonStartedAt =
        ping && (ping as any).ok && typeof (ping as any).startedAt === "number"
          ? ((ping as any).startedAt as number)
          : null;
      const { show, header } = nativeStderrDisplay(mtimeMs, daemonStartedAt);
      if (show) {
        console.log(`\n  ${red}${bold}${header}${reset} ${dim}(${stderrPath})${reset}`);
        for (const line of content.split("\n").slice(-20)) {
          console.log(`  ${red}${line}${reset}`);
        }
        console.log("");
      } else {
        console.log(`\n  ${dim}${header}${reset}\n`);
      }
    }
  }

  // Convention: every surface appends to ~/.mattstack/rt/logs/<surface>.YYYY-MM-DD[.N].log
  // (daemon via pino-roll, cli via lib/cli-logger.ts, tray via TrayLog, ...).
  // Follow the newest file per surface — new surfaces show up in the viewer
  // automatically, nothing to register.
  const SURFACE_LOG_RE = /^([a-z][a-z-]*)\.\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/;
  const newestPerSurface = new Map<string, { f: string; mtime: number }>();
  for (const f of readdirSync(LOG_DIR)) {
    const surface = SURFACE_LOG_RE.exec(f)?.[1];
    if (!surface) continue;
    const mtime = statSync(join(LOG_DIR, f)).mtimeMs;
    const prev = newestPerSurface.get(surface);
    if (!prev || mtime > prev.mtime) newestPerSurface.set(surface, { f, mtime });
  }
  if (newestPerSurface.size === 0) {
    console.log(`\n  ${dim}no log files in ${LOG_DIR} — start the daemon first${reset}\n`);
    return;
  }
  const logPaths = [...newestPerSurface.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ f }) => join(LOG_DIR, f));

  if (terminal) {
    await runTerminalViewer(logPaths);
  } else {
    await runWebViewer(logPaths);
  }
}

/**
 * Open the log in `lnav` (interactive TUI with auto-detected pino support,
 * level coloring, filtering, search, jump-to-error). Stays attached until
 * the user quits lnav with `q`.
 *
 * lnav is the best off-the-shelf TUI for structured logs in 2025:
 *   /text   — search
 *   f       — filter by regex
 *   e / E   — jump to next/prev error-level entry
 *   :filter-in WRN  — only show warnings
 *   q       — quit
 *
 * Falls back to `bunx pino-pretty` if lnav isn't installed.
 */
async function runTerminalViewer(logPaths: string[]): Promise<void> {
  const hasLnav = spawnSync("which", ["lnav"]).status === 0;

  let viewer: ReturnType<typeof spawn>;
  if (hasLnav) {
    // lnav is a full TUI — inherit stdin so keystrokes reach it.
    viewer = spawn("lnav", logPaths, {
      stdio: "inherit",
    });
  } else {
    console.log(`  ${dim}tailing ${logPaths.join(", ")} via pino-pretty (Ctrl-C to stop)${reset}`);
    console.log(`  ${dim}for a nicer interactive view: ${bold}brew install lnav${reset}\n`);
    // sh -c pipeline avoids Bun's stream-as-stdio limitation between two spawns.
    const quoted = logPaths.map(p => JSON.stringify(p)).join(" ");
    viewer = spawn("sh", ["-c", `tail -F ${quoted} | bunx pino-pretty`], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  }

  const stop = (code: number) => {
    try { viewer.kill("SIGTERM"); } catch { /* */ }
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  viewer.on("exit", (code) => stop(code ?? 0));
}

/**
 * logdy UI config that breaks pino JSON lines into proper columns instead
 * of dumping the raw line into one cell. Written to ~/.mattstack/rt/ on first invocation.
 *
 * Schema (verified against logdy v0.17):
 *   - top-level: `name`, `settings`, `columns`
 *   - settings: { maxMessages, entriesOrder, leftColWidth, drawerColWidth,
 *                 middlewares: [...] }
 *   - columns:  { id, name, idx, width, hidden?, faceted?, handlerTsCode? }
 *   - handlerTsCode is TS source: `(line: Message) => CellHandler`
 *
 * logdy parses each JSON line automatically; handlers access fields via the
 * parsed object (different versions expose it as `line.json` or
 * `line.json_content` — we use a defensive helper).
 */
// IMPORTANT: logdy wraps each handler as `let fn = ${ts.transpile(code)}`.
// TypeScript's transpiler can emit prelude statements (e.g. `var _a, _b;` for
// nullish-coalescing helpers in ES5 mode), which would break the wrap with a
// syntax error and silently empty the columns array. To stay safe we use
// plain ES5-style code in every handler: function expressions, `||` instead
// of `??`, manual object iteration instead of destructure-rest, no template
// literals.

const PINO_PARSE_MIDDLEWARE =
  'function(line){try{line.json_content=JSON.parse(line.content);}catch(e){}return line;}';

const HANDLER_TIME = [
  'function(line){',
  '  var j=line.json_content||line.json||{};',
  '  if(!j.time) return {text:""};',
  '  var d=new Date(j.time);',
  '  function p(n,w){var s=String(n);while(s.length<(w||2)) s="0"+s; return s;}',
  '  return {text:p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())+"."+p(d.getMilliseconds(),3)};',
  '}',
].join("");

// CLI command-log lines (cli.YYYY-MM-DD.log) carry {command, outcome} instead
// of pino's {level, module, msg} — each handler falls back so both file
// shapes render in the same columns.
const HANDLER_LEVEL = 'function(line){var j=line.json_content||line.json||{};return {text:j.level||j.outcome||""};}';
const HANDLER_MODULE = 'function(line){var j=line.json_content||line.json||{};return {text:j.module||(j.command!==undefined?"cli":"")};}';
const HANDLER_MSG = 'function(line){var j=line.json_content||line.json||{};return {text:j.msg||(j.command!==undefined?"rt "+j.command:line.content)};}';

const HANDLER_FIELDS = [
  'function(line){',
  '  var j=line.json_content||line.json||{};',
  '  var skip={level:1,time:1,pid:1,hostname:1,module:1,msg:1,command:1,outcome:1};',
  '  var rest={}, has=false;',
  '  for(var k in j){ if(!skip[k]){ rest[k]=j[k]; has=true; } }',
  '  if(!has) return {text:""};',
  '  return {text:JSON.stringify(rest),isJson:true};',
  '}',
].join("");

const LOGDY_PINO_COLUMNS_JSON = JSON.stringify(
  {
    name: "rt-daemon pino",
    settings: {
      maxMessages: 10000,
      entriesOrder: "desc",
      leftColWidth: 200,
      drawerColWidth: 480,
      middlewares: [
        { id: "pino-parse", name: "Parse pino JSON", handlerTsCode: PINO_PARSE_MIDDLEWARE },
      ],
    },
    columns: [
      { id: "time",   name: "time",   idx: 0, width: 110, handlerTsCode: HANDLER_TIME },
      { id: "level",  name: "level",  idx: 1, width:  70, faceted: true, handlerTsCode: HANDLER_LEVEL },
      { id: "module", name: "module", idx: 2, width: 140, faceted: true, handlerTsCode: HANDLER_MODULE },
      { id: "msg",    name: "msg",    idx: 3, width: 520, handlerTsCode: HANDLER_MSG },
      { id: "fields", name: "fields", idx: 4, width: 320, handlerTsCode: HANDLER_FIELDS },
    ],
  },
  null,
  2,
);

/**
 * Materialize the logdy column config under rt/tmp (rewriting only if it
 * changed, so edits to LOGDY_PINO_COLUMNS_JSON above propagate without
 * manual cache busting) and clear out any pre-RT-33-collapse copy left at
 * the rt/ top level. Returns the path logdy's `--config` flag should get.
 */
export function materializeLogdyConfig(): string {
  mkdirSync(tmpDir(), { recursive: true });
  const configPath = join(tmpDir(), "logdy-pino-columns.json");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (existing !== LOGDY_PINO_COLUMNS_JSON) {
    writeFileSync(configPath, LOGDY_PINO_COLUMNS_JSON);
  }

  const legacyPath = join(RT_DIR, "logdy-pino-columns.json");
  try {
    if (existsSync(legacyPath)) unlinkSync(legacyPath);
  } catch { /* best-effort */ }

  return configPath;
}

/**
 * Spawn logdy follow + open browser. Stays attached so user can Ctrl-C.
 */
async function runWebViewer(logPaths: string[]): Promise<void> {
  const which = spawnSync("which", ["logdy"]);
  if (which.status !== 0) {
    console.log(`\n  ${yellow}⚠${reset} logdy not installed.`);
    console.log(`  ${dim}install: ${bold}brew install logdy${reset}`);
    console.log(`  ${dim}or use terminal mode: ${bold}rt daemon logs --terminal${reset}\n`);
    process.exit(1);
  }

  const configPath = materializeLogdyConfig();

  const port = "5544";
  const url = `http://localhost:${port}`;
  console.log(`  ${green}●${reset} starting logdy on ${url}`);
  console.log(`  ${dim}tailing: ${logPaths.join(", ")}${reset}`);

  const logdy = spawn("logdy", [
    "follow", ...logPaths,
    "--port", port,
    "--ui-pass", "",
    "--no-analytics",
    "--config", configPath,
    // --full-read backfills existing file content; without it logdy only
    // tails lines added after launch. Capped by settings.maxMessages.
    "--full-read",
  ], { stdio: ["ignore", "inherit", "inherit"] });

  const stop = (code: number) => {
    try { logdy.kill("SIGTERM"); } catch { /* */ }
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  // Attach before awaiting anything — if logdy exits instantly (e.g. the port
  // is already bound by another process), a listener attached after
  // waitForPort would miss the event and we'd hang pointing the browser at
  // whatever service answered on the port.
  logdy.on("exit", (code) => stop(code ?? 0));

  await waitForPort(Number(port), 2000);
  spawnSync("open", [url]);

  console.log(`  ${green}✓${reset} viewer running on ${url} — ${dim}Ctrl-C to stop${reset}\n`);
}

/** Poll TCP connect until the port is accepting connections, up to timeoutMs. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const { Socket } = require("net");
      const sock: any = new Socket();
      sock.setTimeout(200);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error",   () => { sock.destroy(); resolve(false); });
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
      sock.connect(port, "127.0.0.1");
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Pure formatter for `daemon:log-level` results, shared by the CLI and its tests. */
export function formatLogLevelResult(res: { ok: boolean; level?: string; error?: string }, wasSet: boolean): string {
  if (!res.ok) return `  ${red}●${reset} ${res.error ?? "failed"}`;
  return `  ${green}●${reset} daemon log level ${wasSet ? "set to" : "is"} ${res.level}`;
}

/** Show (no arg) or set (level arg) the running daemon's live pino log level. */
export async function setLogLevel(args: string[] = []): Promise<void> {
  const json = args.includes("--json");
  const level = args.find((a) => !a.startsWith("--"));
  const res = await daemonQuery("daemon:log-level", level ? { level } : {});
  if (!res) { console.log(`  ${red}●${reset} daemon not reachable`); return; }
  if (json) { console.log(JSON.stringify(res)); return; }
  console.log(formatLogLevelResult(res as any, Boolean(level)));
}
