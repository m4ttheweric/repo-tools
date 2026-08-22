#!/usr/bin/env bun

/**
 * rt verify — Installation verification.
 *
 * Checks that all critical rt components are working correctly.
 * Exits 0 if all critical checks pass, 1 if any fail.
 *
 * Designed to run in CI or as a post-install check:
 *   rt verify           # full check with human output
 *   rt verify --json    # machine-readable JSON output
 *   rt verify --ci      # minimal output, strict exit codes
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { detectShell, shellRcPath } from "../lib/shell-integration.ts";
import {
  legacyDirsPresent, RT_DIR_LABEL,
  installedTrayAppPath, legacyTrayAppPaths,
  TRAY_APP_BUNDLE, DEV_TRAY_APP_BUNDLE,
} from "../lib/rt-paths.ts";
import { currentMode } from "../lib/dev-mode.ts";
import { checkRtContextExtension } from "../lib/setup/validators/rt-health.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info";
type Status = "pass" | "fail" | "warn" | "skip";

interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  severity: Severity;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cmd(command: string): string | null {
  try {
    return execSync(command, { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

function pass(name: string, detail: string, severity: Severity = "critical"): CheckResult {
  return { name, status: "pass", detail, severity };
}

function fail(name: string, detail: string, severity: Severity = "critical"): CheckResult {
  return { name, status: "fail", detail, severity };
}

function warn(name: string, detail: string): CheckResult {
  return { name, status: "warn", detail, severity: "warning" };
}

function skip(name: string, detail: string): CheckResult {
  return { name, status: "skip", detail, severity: "info" };
}

// The local binding (imported above) is what runChecks() calls below — do
// not collapse this into `export { checkRtContextExtension } from "…"`.
export { checkRtContextExtension };

// ─── Checks ──────────────────────────────────────────────────────────────────

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const home = homedir();

  // ── Binary ────────────────────────────────────────────────────────────────

  const rtVersion = cmd("rt --version");
  if (rtVersion) {
    results.push(pass("rt binary", rtVersion));
  } else {
    results.push(fail("rt binary", "rt not found on PATH"));
    // If binary doesn't exist, many other checks will also fail — return early
    return results;
  }

  // ── Legacy state dirs (RT-46 canary) ──────────────────────────────────────
  // rt reads only the new tree; a REAL legacy dir means state is split and
  // silently ignored. A symlink is just the inert RT-33 compat shim.

  const legacy = legacyDirsPresent();
  if (legacy.real.length > 0) {
    results.push(fail(
      "legacy state dirs",
      `real legacy dir${legacy.real.length !== 1 ? "s" : ""} present: ${legacy.real.join(", ")} — rt reads only ${RT_DIR_LABEL}; merge by hand, then delete`,
    ));
  } else if (legacy.symlinks.length > 0) {
    results.push(warn(
      "legacy state dirs",
      `compat symlink still present, deletable: ${legacy.symlinks.join(", ")}`,
    ));
  } else {
    results.push(pass("legacy state dirs", `state lives only in ${RT_DIR_LABEL}`));
  }

  // ── Intercept shims (RT-28) ────────────────────────────────────────────────
  try {
    const { shimReport, localBinDir, staleIntercepts } = await import("../lib/endpoint/shim.ts");
    const report = shimReport();
    const missing = report.filter((r) => !r.installed);
    const stale = report.filter((r) => r.installed && !r.current);
    // Distinct from a stale SHIM: the shims can all be current while
    // intercepts.json itself predates a settings-store edit, in which case the
    // rules being matched are last week's (RT-47).
    const staleRules = staleIntercepts();
    // A perfectly installed shim is inert if its directory isn't on PATH —
    // the intercept simply never fires and everything looks fine. Only worth
    // saying once at least one shim actually exists on disk.
    const binDir = localBinDir();
    const onPath = (process.env.PATH ?? "").split(":").some((entry) => entry === binDir || entry.replace(/\/+$/, "") === binDir);
    const pathBroken = report.some((r) => r.installed) && !onPath;
    const pathNote = pathBroken ? ` — and ${binDir} is not on PATH, so intercepts will not fire` : "";
    if (report.length === 0) results.push(skip("intercept shims", "no intercepts declared"));
    else if (missing.length > 0) results.push(warn("intercept shims", `declared but not installed: ${missing.map((r) => r.command).join(", ")} — run rt intercept install${pathNote}`));
    else if (stale.length > 0) results.push(warn("intercept shims", `stale shim content: ${stale.map((r) => r.command).join(", ")} — run rt intercept install${pathNote}`));
    else if (pathBroken) results.push(warn("intercept shims", `shims installed but ${binDir} is not on PATH — intercepts will not fire`));
    else if (staleRules.stale) results.push(warn("intercept shims", `shims are current but the rules cache is stale (${staleRules.reason}) — run rt intercept install`));
    else results.push(pass("intercept shims", `${report.length} installed and current`, "warning"));
  } catch (err) {
    results.push(warn("intercept shims", `check failed: ${(err as Error).message}`));
  }

  // ── Required dependencies ─────────────────────────────────────────────────

  const fzfVersion = cmd("fzf --version");
  if (fzfVersion) {
    results.push(pass("fzf", fzfVersion));
  } else {
    results.push(fail("fzf", "not found — brew install fzf"));
  }

  // ── Tray app (MAT-383 §5) ─────────────────────────────────────────────────
  // Hard-fail ONLY when the ACTIVE flavor's app is missing. currentMode() is
  // the sole flavor signal (dev-mode.json's existence is deliberately not
  // one — see lib/dev-mode.ts). The inactive flavor's absence is purely
  // informational, and any legacyTrayAppPaths() hit is a warning, never a
  // failure.

  const mode = currentMode();
  const activeTrayBundle = mode === "dev" ? DEV_TRAY_APP_BUNDLE : TRAY_APP_BUNDLE;
  const inactiveTrayBundle = mode === "dev" ? TRAY_APP_BUNDLE : DEV_TRAY_APP_BUNDLE;
  const activeTrayPath = installedTrayAppPath(activeTrayBundle);
  const inactiveTrayPath = installedTrayAppPath(inactiveTrayBundle);

  if (activeTrayPath) {
    const plistPath = join(activeTrayPath, "Contents/Info.plist");
    const trayVersion = existsSync(plistPath)
      ? cmd(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${plistPath}" 2>/dev/null`)
      : null;
    results.push(pass(activeTrayBundle, trayVersion ? `v${trayVersion} at ${activeTrayPath}` : `installed at ${activeTrayPath}`));
  } else {
    results.push(fail(activeTrayBundle, "not found — expected in /Applications or ~/Applications"));
  }

  results.push(inactiveTrayPath
    ? skip(inactiveTrayBundle, `also installed at ${inactiveTrayPath} (inactive flavor)`)
    : skip(inactiveTrayBundle, "not installed (inactive flavor)"));

  const legacyHits = legacyTrayAppPaths().filter(existsSync);
  if (legacyHits.length > 0) {
    results.push(warn("legacy tray app", `old bundle still present: ${legacyHits.join(", ")}`));
  }

  // ── rt-context extension (MAT-383 §5) ─────────────────────────────────────

  results.push(checkRtContextExtension(home));

  // ── Shell integration ─────────────────────────────────────────────────────

  const shell = detectShell();
  const rcFile = shellRcPath(shell);
  const hasRtcdInRc = !!rcFile && existsSync(rcFile) && readFileSync(rcFile, "utf8").includes("rtcd");
  if (hasRtcdInRc) {
    results.push(pass("shell integration", `rtcd alias in ${rcFile}`, "warning"));
  } else {
    results.push(warn("shell integration", `rtcd not found in ${rcFile ?? "rc file"} — may need terminal restart`));
  }

  // ── Daemon ────────────────────────────────────────────────────────────────

  const { isDaemonInstalled, activeLaunchdLabel } = await import("../lib/daemon-config.ts");
  const { isDaemonRunning, daemonQuery } = await import("../lib/daemon-client.ts");

  if (!isDaemonInstalled()) {
    results.push(fail("daemon installed", "not installed — run: rt daemon install"));
    return results;
  }

  results.push(pass("daemon installed", "config exists at ~/.mattstack/rt/daemon.json"));

  // Check launchd registration (MAT-383 §5: activeLaunchdLabel() is the flavor-
  // aware label — dev and prod daemons register under different jobs).
  const launchdLabel = activeLaunchdLabel();
  const launchctlCheck = cmd(`launchctl list ${launchdLabel} 2>/dev/null`);
  if (launchctlCheck && !launchctlCheck.includes("Could not find")) {
    results.push(pass("daemon launchd", `registered with launchd as ${launchdLabel} (auto-starts on login)`));
  } else {
    results.push(warn("daemon launchd", `not registered with launchd as ${launchdLabel} — won't auto-start on login. Run: rt daemon install`));
  }

  const running = await isDaemonRunning();
  if (!running) {
    // SMAppService LaunchAgents require Background Task Management approval
    // on first install. In CI / headless sessions there's no one to approve,
    // so the daemon won't actually boot — installation is still correct.
    const inCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
    if (inCi) {
      results.push(warn("daemon running", "not booted (expected in CI — needs user approval in Login Items on first launch)"));
    } else {
      results.push(fail("daemon running", `installed but not responding — open ${activeTrayPath} and approve in System Settings → General → Login Items`));
    }
    return results;
  }

  // Query daemon status
  const response = await daemonQuery("status");
  if (response?.ok) {
    const { pid, uptime, watchedRepos, cacheEntries } = response.data;
    const uptimeSec = Math.floor(uptime / 1000);
    results.push(pass("daemon running", `pid ${pid}, uptime ${uptimeSec}s, watching ${watchedRepos} repos, ${cacheEntries} cache entries`));
  } else {
    results.push(pass("daemon running", "responding (status query unavailable)"));
  }

  // Quick smoke test: daemon can handle a known command
  const pingResponse = await daemonQuery("worktrees");
  if (pingResponse !== null) {
    results.push(pass("daemon api", "worktrees endpoint responding"));
  } else {
    results.push(fail("daemon api", "worktrees endpoint not responding"));
  }

  // ── TCC: can the daemon actually read user repos? ─────────────────────────
  // The shell running rt verify has its own TCC grants, so file access checks
  // here would always pass. Ask the daemon — it's the one that gets EPERM
  // when macOS hasn't granted Full Disk Access to the rt binary.
  const tccResponse = await daemonQuery("tcc:check");
  if (tccResponse?.ok) {
    const { blocked, accessible, totalRepos } = tccResponse.data;
    if (totalRepos === 0) {
      results.push(skip("tcc access", "no repos registered yet"));
    } else if (blocked.length === 0) {
      results.push(pass("tcc access", `daemon can read all ${accessible.length} registered repo${accessible.length !== 1 ? "s" : ""}`));
    } else {
      const paths = blocked.map((b: any) => b.path).join(", ");
      results.push(fail(
        "tcc access",
        `daemon blocked from ${blocked.length} repo${blocked.length !== 1 ? "s" : ""} (${paths}). Run: rt --grant-fda  then add 'rt' under Full Disk Access`,
      ));
    }
  }

  return results;
}

// ─── Output formatters ────────────────────────────────────────────────────────

/**
 * Shared human-readable format — used for both terminal and CI.
 * When noColor=true, ANSI codes are stripped so CI logs stay readable.
 */
function printHuman(results: CheckResult[], noColor = false): void {
  const c = (code: string) => (noColor ? "" : code);

  const icons: Record<Status, string> = {
    pass: `${c(green)}✓${c(reset)}`,
    fail: `${c(red)}✗${c(reset)}`,
    warn: `${c(yellow)}⚠${c(reset)}`,
    skip: `${c(dim)}–${c(reset)}`,
  };

  console.log("");
  console.log(`  ${c(bold)}${c(cyan)}rt verify${c(reset)}`);
  console.log("");

  for (const r of results) {
    console.log(`  ${icons[r.status]} ${r.name}  ${c(dim)}${r.detail}${c(reset)}`);
  }

  const failures = results.filter((r) => r.status === "fail" && r.severity === "critical");
  const warnings = results.filter((r) => r.status === "warn" || (r.status === "fail" && r.severity === "warning"));
  const passes = results.filter((r) => r.status === "pass");

  console.log("");
  if (failures.length === 0) {
    console.log(`  ${c(green)}${c(bold)}✓ all critical checks passed${c(reset)}  ${c(dim)}${passes.length} passed, ${warnings.length} warnings${c(reset)}`);
  } else {
    console.log(`  ${c(red)}${c(bold)}✗ ${failures.length} critical check${failures.length !== 1 ? "s" : ""} failed${c(reset)}  ${c(dim)}${passes.length} passed, ${warnings.length} warnings${c(reset)}`);
  }
  console.log("");
}

function printJSON(results: CheckResult[]): void {
  const failures = results.filter((r) => r.status === "fail" && r.severity === "critical");
  console.log(JSON.stringify({
    passed: failures.length === 0,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      warn: results.filter((r) => r.status === "warn").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
    checks: results,
  }, null, 2));
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runVerify(args: string[]): Promise<void> {
  const isCI = args.includes("--ci") || process.env.CI === "true";
  const isJSON = args.includes("--json");

  const results = await runChecks();
  const failures = results.filter((r) => r.status === "fail" && r.severity === "critical");

  if (isJSON) {
    printJSON(results);
  } else if (isCI) {
    printHuman(results, /* noColor */ true);
  } else {
    printHuman(results);
  }

  if (failures.length > 0) {
    process.exit(1);
  }
}
