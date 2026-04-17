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

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { detectShell, shellRcPath } from "../lib/shell-integration.ts";

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

  // ── Required dependencies ─────────────────────────────────────────────────

  const fzfVersion = cmd("fzf --version");
  if (fzfVersion) {
    results.push(pass("fzf", fzfVersion));
  } else {
    results.push(fail("fzf", "not found — brew install fzf"));
  }

  // ── Tray app ──────────────────────────────────────────────────────────────

  const trayPath = join(home, "Applications", "rt-tray.app");
  const plistPath = join(trayPath, "Contents/Info.plist");
  if (existsSync(trayPath)) {
    const trayVersion = existsSync(plistPath)
      ? cmd(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${plistPath}" 2>/dev/null`)
      : null;
    results.push(pass("rt-tray.app", trayVersion ? `v${trayVersion} in ~/Applications` : "installed in ~/Applications"));
  } else {
    // Fallback: check if the tray is at least present in the Homebrew prefix
    // (post_install may not have run yet, but the package IS correct)
    const rtExec = process.execPath;
    const prefixTray = [
      join(rtExec, "../../rt-tray.app"),
      join(rtExec, "../rt-tray.app"),
    ].find(existsSync);
    if (prefixTray) {
      results.push(warn("rt-tray.app", "in Homebrew prefix but not yet in ~/Applications — re-run: rt --post-install"));
    } else {
      results.push(fail("rt-tray.app", "not found in ~/Applications or Homebrew prefix — formula may be missing it"));
    }
  }


  // ── Extension VSIX in prefix ──────────────────────────────────────────────

  const brewPrefix = cmd("brew --prefix m4ttheweric/tap/rt 2>/dev/null") ??
                     cmd("brew --prefix rt 2>/dev/null");
  if (brewPrefix) {
    const vsixPath = join(brewPrefix, "rt-context.vsix");
    if (existsSync(vsixPath)) {
      results.push(pass("rt-context.vsix", `in ${brewPrefix}`));
    } else {
      results.push(fail("rt-context.vsix", `not found in ${brewPrefix}`));
    }
  } else {
    // Not installed via Homebrew — check source mode
    results.push(skip("rt-context.vsix", "Homebrew prefix not found (source install?)"));
  }

  // ── Extension installed in editors ────────────────────────────────────────

  const editors = [
    { name: "Cursor",             appPath: "/Applications/Cursor.app",             cliBinary: "cursor" },
    { name: "Visual Studio Code", appPath: "/Applications/Visual Studio Code.app", cliBinary: "code" },
    { name: "Antigravity",        appPath: "/Applications/Antigravity.app",         cliBinary: "antigravity" },
  ];

  let anyEditorFound = false;
  for (const editor of editors) {
    if (!existsSync(editor.appPath)) continue;
    anyEditorFound = true;
    const cliPath = join(editor.appPath, "Contents/Resources/app/bin", editor.cliBinary);
    if (!existsSync(cliPath)) {
      results.push(warn(`${editor.name} extension`, "app found but CLI missing"));
      continue;
    }
    const result = spawnSync(cliPath, ["--list-extensions"], { encoding: "utf8", timeout: 15_000 });
    const exts = (result.stdout ?? "").split("\n").map((e: string) => e.trim().toLowerCase());
    const installed = exts.some((e: string) => e.includes("rt-context"));
    if (installed) {
      results.push(pass(`${editor.name} extension`, "rt-context installed", "warning"));
    } else {
      results.push(warn(`${editor.name} extension`, `rt-context not installed — run: rt settings extension`));
    }
  }

  if (!anyEditorFound) {
    results.push(skip("editor extension", "no VS Code-compatible editors found in /Applications"));
  }

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

  const { isDaemonInstalled } = await import("../lib/daemon-config.ts");
  const { isDaemonRunning, daemonQuery } = await import("../lib/daemon-client.ts");

  if (!isDaemonInstalled()) {
    results.push(fail("daemon installed", "not installed — run: rt daemon install --launchd"));
    return results;
  }

  results.push(pass("daemon installed", "config exists at ~/.rt/daemon.json"));

  // Check launchd registration
  const launchctlCheck = cmd("launchctl list com.rt.daemon 2>/dev/null");
  if (launchctlCheck && !launchctlCheck.includes("Could not find")) {
    results.push(pass("daemon launchd", "registered with launchd (auto-starts on login)"));
  } else {
    results.push(warn("daemon launchd", "not registered with launchd — won't auto-start on login. Run: rt daemon install --launchd"));
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
      results.push(fail("daemon running", "installed but not responding — open ~/Applications/rt-tray.app and approve in System Settings → General → Login Items"));
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
