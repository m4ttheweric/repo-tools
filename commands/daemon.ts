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
import { join } from "path";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { bold, dim, green, yellow, red, reset } from "../lib/tui.ts";
import {
  isDaemonInstalled,
  markDaemonInstalled, markDaemonUninstalled, cleanupDaemonFiles,
  readDaemonPid,
  RT_DIR,
  LOG_DIR,
  LAUNCHD_PLIST_PATH,
} from "../lib/daemon-config.ts";
import { daemonQuery, isDaemonRunning, trayQuery } from "../lib/daemon-client.ts";
import { classifyDaemonStatus, type DaemonStatusVerdict } from "../lib/daemon-status.ts";
import { isGitLabRemote } from "../lib/enrich.ts";
import type { CacheKind } from "../lib/repo-tracking.ts";
import { loadRepoTracking, grants, saveRepoTracking, parseCachesArg, CACHE_KINDS, DEFAULT_PROJECT_MRS_WINDOW_DAYS } from "../lib/repo-tracking.ts";
import { createProjectMRs, PROJECT_MRS_PATH } from "../lib/daemon/project-mrs-store.ts";
import { timeAgo } from "../lib/tui/utils/label.ts";
import { trayAppPath, TRAY_APP_NAME, TRAY_APP_BUNDLE } from "../lib/rt-paths.ts";

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
    console.log(`  ${dim}  ${bold}open ${trayAppPath()}${reset}`);
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
    console.log(`\n  ${yellow}${TRAY_APP_NAME} is not running${reset}`);
    console.log(`  ${dim}open it: ${bold}open ${trayAppPath()}${reset}\n`);
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
  console.log(`\n  ${yellow}${TRAY_APP_NAME} is not running — nothing to stop${reset}\n`);
}

export async function restart(): Promise<void> {
  const result = await trayQuery("/daemon/restart", "POST");
  if (!result?.ok) {
    console.log(`\n  ${yellow}${TRAY_APP_NAME} is not running${reset}`);
    console.log(`  ${dim}open it: ${bold}open ${trayAppPath()}${reset}\n`);
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
  // A failed status query does NOT mean the daemon is down — it answers `ping`
  // in a fraction of the budget a loaded `status` needs. Establish liveness
  // before reporting, and only pay for the probe when nothing came back.
  const alive = classifyDaemonStatus.needsLivenessProbe(response) ? await isDaemonRunning() : false;
  const verdict = classifyDaemonStatus({
    installed: true,
    response,
    alive,
    pid: readDaemonPid() ?? null,
  });

  for (const line of statusLines(verdict, Date.now())) console.log(line);

  console.log(`    ${dim}config: ~/.mattstack/rt/daemon.json${reset}`);
  console.log(`    ${dim}logs: ~/.mattstack/rt/logs/ ${reset}${dim}(view with: rt daemon logs)${reset}`);
  console.log("");
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
    return lines;
  }

  if (verdict.state === "degraded") {
    // Up, but `status` did not come back. Saying "not running" here would send
    // the operator to `rt daemon start` against a daemon that is already up.
    const lines = [`  ${yellow}●${reset} running, but not reporting status`];
    if (verdict.pid) lines.push(`    ${dim}pid: ${verdict.pid}${reset}`);
    lines.push(
      verdict.reason === "error"
        ? `    ${dim}status command failed: ${verdict.detail ?? "unknown error"}${reset}`
        : `    ${dim}answers ping, but status timed out — likely mid-sync${reset}`,
    );
    lines.push(`    ${dim}check: rt daemon logs${reset}`);
    return lines;
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
  try {
    return JSON.parse(readFileSync(join(RT_DIR, "repos.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Manage per-repo background tracking.
 *
 *   rt daemon track                      list repos with level + watcher state
 *   rt daemon track <repo> live|poll     events watcher + 5-min enrichment (branches by default)
 *   rt daemon track <repo> off           no background API calls (default)
 *   rt daemon track <repo> live|poll <caches>  opt-in to specific caches (branches,project-mrs,discussions)
 *
 * "off" removes the entry (off is the default for unlisted repos). Level
 * changes apply immediately for watchers; the 5-min poll picks up poll/off
 * changes on its next cycle, so `live`/`poll` also kick a refresh.
 */
export async function manageTracking(args: string[] = []): Promise<void> {
  const [repoArg, levelArg] = args;

  if (!repoArg) {
    const repos = readRepoIndex();
    const tracking = loadRepoTracking();
    const status = await daemonQuery("status");
    const freshness = ((status?.ok ? status.data?.freshness : undefined) ?? {}) as
      Record<string, { state: string }>;

    console.log(`\n  ${bold}repo tracking${reset} ${dim}(opt-in · ~/.mattstack/rt/repo-tracking.json · unlisted = off)${reset}\n`);
    for (const name of Object.keys(repos).sort()) {
      const g = grants(tracking, name);
      const watcher = freshness[name];
      const marker = g.mode === "live" ? `${green}●${reset}` : g.mode === "poll" ? `${yellow}◐${reset}` : `${dim}○${reset}`;
      const detail = g.mode === "live"
        ? `live${watcher ? ` (${watcher.state})` : " (watcher starting)"}`
        : g.mode === "poll" ? "poll" : "";
      const suffix = g.mode === "off" ? "" : ` [${[...g.caches].join(", ")}] window ${formatWindowLabel(tracking[name]?.projectMrsWindowDays)}`;
      console.log(`  ${marker} ${g.mode === "off" ? `${dim}${name}${reset}` : name}${detail ? ` ${dim}${detail}${reset}` : ""}${suffix ? ` ${dim}${suffix}${reset}` : ""}`);
    }
    // Tracking entries that no longer match a registered repo do nothing;
    // surface them so a rename or typo isn't silently inert.
    for (const name of Object.keys(tracking).filter((n) => !repos[n])) {
      console.log(`  ${yellow}!${reset} ${name} ${dim}(tracked but not in ~/.mattstack/rt/repos.json)${reset}`);
    }
    console.log(`\n  ${dim}set: rt daemon track <repo> live|poll|off [caches]   caches: ${[...CACHE_KINDS].join(",")} (default branches)${reset}\n`);
    return;
  }

  // ── rt daemon track <repo> — interactive editor (house style: fzf flow) ──
  let interactiveLevel: string | undefined;
  let interactiveCaches: CacheKind[] | undefined;
  let interactiveWindowDays: number | null | undefined; // undefined = untouched, null = clear
  if (!levelArg) {
    if (!readRepoIndex()[repoArg]) {
      console.log(`\n  ${red}✗${reset} repo "${repoArg}" not registered in ~/.mattstack/rt/repos.json\n`);
      return;
    }
    const { filterableSelect, filterableMultiselect, textInput } = await import("../lib/rt-render.tsx");
    const rawTracking = loadRepoTracking();
    const rawEntry = rawTracking[repoArg];
    const current = grants(rawTracking, repoArg);
    const modeHint = (m: string) => (current.mode === m ? "current" : undefined);

    console.log(`\n  ${bold}${repoArg}${reset} ${dim}window ${formatWindowLabel(rawEntry?.projectMrsWindowDays)}${reset}`);
    // Read-only: the store is written only by the daemon (deep sync,
    // registerDemand), never by the CLI.
    const demands = createProjectMRs(PROJECT_MRS_PATH).read(repoArg)?.demands;
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
    const repoPath = readRepoIndex()[repoArg];
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

  const tracking = loadRepoTracking();
  const previousEntry = levelArg2 !== "off" ? tracking[repoArg] : undefined;
  if (levelArg2 === "off") {
    delete tracking[repoArg];
  } else {
    // Only the interactive editor ever touches the window; the positional
    // CLI form (rt daemon track <repo> live [caches]) carries whatever the
    // entry it's replacing already had.
    const windowDays = interactiveWindowDays !== undefined
      ? (interactiveWindowDays ?? undefined)
      : previousEntry?.projectMrsWindowDays;
    tracking[repoArg] = {
      mode: levelArg2 as "live" | "poll",
      caches,
      ...(windowDays !== undefined ? { projectMrsWindowDays: windowDays } : {}),
    };
  }
  saveRepoTracking(tracking);
  console.log(`\n  ${green}✓${reset} ${repoArg} tracking: ${levelArg2}${levelArg2 === "off" ? "" : ` [${caches.join(", ")}] window ${formatWindowLabel(tracking[repoArg]?.projectMrsWindowDays)}`}`);
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
    const watching = Object.keys((res.data ?? {}) as Record<string, unknown>).sort();
    console.log(`    ${dim}live watchers: ${watching.length > 0 ? watching.join(", ") : "none"}${reset}`);
    if (levelArg2 !== "off") await daemonQuery("cache:refresh");
    console.log("");
  } else {
    console.log(`    ${dim}daemon not reachable; applies when it next starts or refreshes${reset}\n`);
  }
}

// ─── Logs ────────────────────────────────────────────────────────────────────

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
  // freopen of fd 2. If non-empty, the most recent crash leads the output.
  const stderrPath = join(LOG_DIR, "daemon-stderr.log");
  if (existsSync(stderrPath)) {
    const content = readFileSync(stderrPath, "utf8").trim();
    if (content) {
      console.log(`\n  ${red}${bold}native stderr${reset} ${dim}(${stderrPath})${reset}`);
      for (const line of content.split("\n").slice(-20)) {
        console.log(`  ${red}${line}${reset}`);
      }
      console.log("");
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

  // Materialize the column config once; rewrite if it changed (so edits to
  // LOGDY_PINO_COLUMNS_JSON above propagate without manual cache busting).
  const configPath = join(LOG_DIR, "..", "logdy-pino-columns.json");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (existing !== LOGDY_PINO_COLUMNS_JSON) {
    writeFileSync(configPath, LOGDY_PINO_COLUMNS_JSON);
  }

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
