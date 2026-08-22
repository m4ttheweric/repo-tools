/**
 * rt --post-install — the installer. Auto-triggered on the first `rt`
 * invocation, re-run by `rt update` from the freshly extracted release.
 *
 * Run from an extracted release tarball (rt + mattstack.app + rt-context.vsix
 * side by side) it is a complete install:
 *   1. Copy mattstack.app → ~/Applications (remove quarantine)
 *   2. Install this binary at ~/.local/bin/rt — a symlink to the bundle's
 *      OWN Contents/MacOS/rt (step 1 must run first, since the link target
 *      lives inside what it just copied), unless dev mode owns that path
 *   3. Install rt-context.vsix into all detected editors (best-effort, non-interactive)
 *   4. Install daemon as a launchd agent (auto-starts on login)
 *   5. Write shell integration to the user's rc file (PATH + rtcd, idempotent)
 *
 * Run from an already-installed binary, steps 1-3 find nothing beside it and
 * skip; the rest still reconcile.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, cpSync, writeFileSync, realpathSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { TRAY_APP_NAME, TRAY_APP_BUNDLE, trayAppInstallDest, legacyTrayAppPaths } from "../lib/rt-paths.ts";
import { currentMode, installRtBinary, rtBinaryPath } from "../lib/dev-mode.ts";
import { RT_BUNDLE_PATH } from "../lib/bundle-layout.ts";
import { installShellIntegration, detectShell, shellRcPath } from "../lib/shell-integration.ts";
import { EDITOR_PATTERNS } from "../lib/editors.ts";

const HOME = homedir();

function log(icon: string, label: string, detail = ""): void {
  const detailStr = detail ? `  ${detail}` : "";
  console.log(`  ${icon} ${label}${detailStr}`);
}

function ok(label: string, detail = "")  { log("✓", label, detail); }
function fail(label: string, detail = "") { log("✗", label, detail); }
function info(label: string, detail = "") { log("·", label, detail); }
function warn(label: string, detail = "") { log("⚠", label, detail); }

// ─── 1. rt binary ─────────────────────────────────────────────────────────────

/**
 * Where installRtBinaryStep should link `~/.local/bin/rt` from. Prefers the
 * rt inside the just-installed bundle (`bundleInstallDest`) over
 * `execPath` (the binary running THIS install, sitting in the transient
 * extracted-tarball dir) — the symlink must survive the tarball being
 * deleted after install, so it can never target that dir. Falls back to
 * `execPath` only when the bundle doesn't carry Contents/MacOS/rt (an older
 * tarball layout) and we can tell we're running from an extracted release at
 * all; returns null when neither is true (an already-installed binary with
 * nothing beside it to install from).
 */
export function resolveRtBinarySrc(
  bundleInstallDest: string,
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): { src: string; fallbackWarning: boolean } | null {
  const bundleBinary = join(bundleInstallDest, RT_BUNDLE_PATH);
  if (exists(bundleBinary)) return { src: bundleBinary, fallbackWarning: false };
  if (exists(resolve(execPath, `../${TRAY_APP_BUNDLE}`))) return { src: execPath, fallbackWarning: true };
  return null;
}

function installRtBinaryStep(): void {
  const dest = rtBinaryPath();
  if (currentMode() === "dev") {
    info("rt", `dev mode owns ${dest} — leaving the wrapper in place`);
    return;
  }

  const resolved = resolveRtBinarySrc(trayAppInstallDest(), process.execPath);
  if (!resolved) {
    info("rt", "not running from an extracted release — skipping binary install");
    return;
  }
  if (resolved.fallbackWarning) {
    warn("rt", `${TRAY_APP_BUNDLE} has no ${RT_BUNDLE_PATH} — linking to the extracted binary instead`);
  }
  const src = resolved.src;

  let alreadyThere = false;
  try { alreadyThere = existsSync(dest) && realpathSync(dest) === realpathSync(src); } catch { /* unreadable dest: install over it */ }
  if (alreadyThere) {
    info("rt", `already installed at ${dest}`);
    return;
  }

  try {
    installRtBinary(src);
    ok("rt", `→ ${dest}`);
  } catch (err: any) {
    fail("rt", err?.message ?? String(err));
  }
}

// ─── 2. Tray app ──────────────────────────────────────────────────────────────

function installTrayApp(): void {
  const srcTray = resolve(process.execPath, `../${TRAY_APP_BUNDLE}`);
  if (!existsSync(srcTray)) {
    fail(TRAY_APP_BUNDLE, "not found alongside binary — skipping");
    return;
  }

  const destTray = trayAppInstallDest();
  const appsDir = dirname(destTray);

  try {
    // Quit any running instance first — `open` on a running app just activates
    // the existing process and never boots the newly-copied binary. Uses the
    // app's OWN current name (TRAY_APP_NAME) so upgrade-quit keeps working on
    // the next rename (spec §4 risk 5) — this is distinct from the one-shot
    // legacy sweep below, which quits the OLD rt-tray identity by its own
    // never-changing name.
    spawnSync("osascript", ["-e", `tell application "${TRAY_APP_NAME}" to quit`], { stdio: "pipe", timeout: 3_000, env: process.env });
    spawnSync("pkill", ["-x", TRAY_APP_NAME], { stdio: "pipe", env: process.env });

    mkdirSync(appsDir, { recursive: true });
    if (existsSync(destTray)) rmSync(destTray, { recursive: true, force: true });
    cpSync(srcTray, destTray, { recursive: true });

    // Remove quarantine so macOS doesn't block launch
    spawnSync("xattr", ["-cr", destTray], { stdio: "pipe", env: process.env });

    ok(TRAY_APP_BUNDLE, `→ ${destTray}`);
  } catch (err: any) {
    fail(TRAY_APP_BUNDLE, err?.message ?? String(err));
  }
}

// ─── 3. Extension ─────────────────────────────────────────────────────────────

function findVsix(): string | null {
  const candidate = resolve(process.execPath, "../rt-context.vsix");
  return existsSync(candidate) ? candidate : null;
}

function installExtensions(): void {
  const vsix = findVsix();
  if (!vsix) {
    info("rt-context.vsix", "not found alongside binary — skipping");
    return;
  }

  const appDirs = ["/Applications", join(HOME, "Applications")];
  let installedCount = 0;

  for (const appDir of appDirs) {
    if (!existsSync(appDir)) continue;
    let apps: string[];
    try { apps = readdirSync(appDir); } catch { continue; }

    for (const pattern of EDITOR_PATTERNS) {
      if (!apps.includes(pattern.appName)) continue;
      const cliPath = join(appDir, pattern.appName, "Contents/Resources/app/bin", pattern.cliBinary);
      if (!existsSync(cliPath)) continue;

      // spawnSync doesn't throw on non-zero exit or timeout — check the result.
      const result = spawnSync(cliPath, ["--install-extension", vsix, "--force"], {
        stdio: "pipe",
        timeout: 30_000,
        env: process.env,
      });
      if (result.status === 0 && !result.error) {
        ok(`rt-context → ${pattern.displayName}`);
        installedCount++;
      } else {
        fail(`rt-context → ${pattern.displayName}`, "install failed");
      }
    }
  }

  if (installedCount === 0) {
    info("rt-context", "no compatible editors found (install later: rt settings extension)");
  }
}

// ─── 4. Daemon ────────────────────────────────────────────────────────────────

async function installDaemon(): Promise<void> {
  try {
    const result = spawnSync(process.execPath, ["daemon", "install"], {
      stdio: "pipe",
      timeout: 15_000,
      env: process.env,
    });

    if (result.status !== 0) {
      const msg = result.stderr?.toString().trim() || "non-zero exit";
      fail("daemon", msg);
      return;
    }

    ok("daemon", "installed (tray-managed)");

    const { isDaemonRunning } = await import("../lib/daemon-client.ts");
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(250);
      if (await isDaemonRunning()) { ok("daemon", "running"); return; }
    }
    info("daemon", `will start when ${TRAY_APP_NAME} launches`);
  } catch (err: any) {
    fail("daemon", err?.message ?? String(err));
  }
}


// ─── 5. Shell integration ─────────────────────────────────────────────────────────

function installShellIntegrationStep(): void {
  const result = installShellIntegration();
  if (result.alreadyInstalled) {
    info("shell integration", `already configured (${result.shell})`);
  } else if (result.written) {
    ok("shell integration", `added to ${result.rcPath}`);
  } else {
    fail("shell integration", result.error ?? "unknown error");
  }
}

// ─── 6. TCC / Full Disk Access check ─────────────────────────────────────────

async function checkTccAccess(): Promise<void> {
  try {
    const { daemonQuery } = await import("../lib/daemon-client.ts");
    const response = await daemonQuery("tcc:check");
    if (!response?.ok) return;

    const { blocked, totalRepos } = response.data;
    if (totalRepos === 0 || blocked.length === 0) return;

    console.log("");
    fail("tcc access", `daemon is blocked from ${blocked.length} repo${blocked.length !== 1 ? "s" : ""}`);
    for (const b of blocked) {
      console.log(`    ${b.path}`);
    }
    console.log("");
    console.log(`  The daemon inherits Full Disk Access from ${TRAY_APP_BUNDLE}.`);
    console.log(`  Grant FDA to ${TRAY_APP_NAME}, then restart the daemon:`);
    console.log("");
    console.log("    1. System Settings → Privacy & Security → Full Disk Access");
    console.log(`    2. Click + and add: ${trayAppInstallDest()}`);
    console.log("    3. rt daemon restart");
    console.log("");
    spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], { stdio: "pipe" });
  } catch { /* daemon not reachable — skip silently */ }
}

// ─── 7. Shell wrapper repair ─────────────────────────────────────────────────

/**
 * The v0.x shell wrapper used `command -v rt` to resolve the binary path.
 * In zsh, `command -v rt` returns the function name (not the binary path),
 * so rt_bin="rt" and every call recurses until FUNCNEST blows up.
 * Replace the broken line with whence -p / type -P (PATH-only lookup).
 */
function repairShellWrapper(): void {
  const shell = detectShell();
  const rcPath = shellRcPath(shell);
  if (!rcPath) return;

  let content: string;
  try { content = readFileSync(rcPath, "utf8"); } catch { return; }

  if (!content.includes("rt() {") || !content.includes("command -v rt") || content.includes("whence -p rt")) return;

  const broken = '  [ -x "$rt_bin" ] || rt_bin="$(command -v rt 2>/dev/null || echo rt)"';
  const fixed = [
    '  # whence -p (zsh) / type -P (bash): PATH-only lookup, skips this function',
    '  [ -x "$rt_bin" ] || rt_bin="$(whence -p rt 2>/dev/null || type -P rt 2>/dev/null)"',
    '  [ -x "$rt_bin" ] || { echo "rt: binary not found in PATH" >&2; return 1; }',
  ].join("\n");

  const repaired = content.replace(broken, fixed);
  // Exact-string replace: if the rc line differs (hand-edited whitespace),
  // nothing changed — don't rewrite the file or claim a repair happened.
  if (repaired === content) return;
  writeFileSync(rcPath, repaired);
  ok("shell wrapper", "repaired FUNCNEST recursion bug");
}

// ─── 0. One-shot legacy migration sweep (MAT-383 §4) ─────────────────────────
//
// `rt --post-install` runs on every fresh install, every `rt update`, and
// every first-run-without-daemon.json path (cli.ts). An unguarded sweep would
// `launchctl bootout` on every routine run, so it is GUARDED: it fires only
// while a legacy rt-tray.app bundle is still on disk, and it can NEVER move
// into `rt daemon install` (runPostInstall spawns that AFTER the new app
// registers; a sweep there would boot out the daemon it just started).
//
// Order (all before installing the new app): quit the OLD app by its own
// never-changing name → stop its old launchd job → delete its bundle(s).

/** True only when at least one legacy rt-tray.app candidate still exists. */
function legacySweepNeeded(): boolean {
  return legacyTrayAppPaths().some(existsSync);
}

function runLegacySweep(): void {
  info("legacy migration", "rt-tray.app found — migrating to " + TRAY_APP_BUNDLE);

  // 1. Quit the OLD app by ITS OWN identity — "rt-tray" never changes no
  //    matter what the new app gets renamed to next, unlike TRAY_APP_NAME
  //    above (that's installTrayApp()'s own-app upgrade-quit).
  spawnSync("osascript", ["-e", 'tell application "rt-tray" to quit'], { stdio: "pipe", timeout: 3_000, env: process.env });
  spawnSync("pkill", ["-x", "rt-tray"], { stdio: "pipe", env: process.env });

  // 2. Stop the old launchd job. Honest limitation (spec §4 step 2): bootout
  //    stops the job but does NOT remove the old bundle's BTM/SMAppService
  //    registration record — only the old app itself could unregister it,
  //    and it's about to be deleted below. The inert record (a ghost row in
  //    System Settings → Login Items) persists until manually removed; sole-
  //    user cost accepted, no claim that macOS drops it on its own.
  //    `rt verify` warns while a legacy bundle path still exists.
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/com.rt.daemon`], { stdio: "pipe", env: process.env });

  // 3. Remove every legacy bundle candidate that actually exists.
  for (const legacyPath of legacyTrayAppPaths()) {
    if (!existsSync(legacyPath)) continue;
    spawnSync("rm", ["-rf", legacyPath], { stdio: "pipe", env: process.env });
  }

  ok("legacy migration", "rt-tray.app removed");
}

/**
 * Success detection for the migration (spec §4 step 4): pings the daemon
 * socket/health endpoint and reports LOUDLY if the new registration did not
 * come up — migration must not end on an unverified "should work". Also
 * prints the one-time note that notification + full-disk-access permissions
 * must be re-granted, since the bundle id changed. Both only make sense (and
 * only run) when a migration actually happened this run.
 */
async function reportMigrationOutcome(): Promise<void> {
  const { isDaemonRunning } = await import("../lib/daemon-client.ts");
  if (await isDaemonRunning()) {
    ok("migration", "daemon healthy under the new registration");
  } else {
    console.log("");
    fail("migration", "daemon did not come up under the new registration");
    console.log("  The migration off rt-tray.app may not have completed cleanly.");
    console.log("  Check: rt daemon status   /   rt verify");
    console.log("");
  }

  console.log("");
  console.log(`  NOTE: notification + full-disk-access permissions must be re-granted`);
  console.log(`  for ${TRAY_APP_BUNDLE} — the bundle id changed as part of this migration.`);
  console.log("");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runPostInstall(): Promise<void> {
  console.log("");
  console.log("  rt post-install");
  console.log("");

  // One-shot legacy migration sweep (spec §4) — GUARDED and MUST run before
  // the new app is installed/launched below. See runLegacySweep()'s docblock
  // for why this can never move into `rt daemon install`.
  const migrating = legacySweepNeeded();
  if (migrating) runLegacySweep();

  installTrayApp();
  installRtBinaryStep();
  installExtensions();

  // Launch mattstack.app BEFORE installing the daemon so the tray's HTTP
  // server is up when `rt daemon install` calls trayQuery("/daemon/start").
  const trayDest = trayAppInstallDest();
  if (existsSync(trayDest)) {
    spawnSync("open", [trayDest], { stdio: "pipe", env: process.env });
    ok(TRAY_APP_BUNDLE, "launched — waiting for tray to start…");
    // Give the tray's NWListener a moment to bind the socket before we send
    // it the /daemon/start request.
    await Bun.sleep(2_000);
  }

  await installDaemon();
  installShellIntegrationStep();
  repairShellWrapper();

  await checkTccAccess();

  if (migrating) await reportMigrationOutcome();

  console.log("");
  console.log("  Done. Restart your terminal, then run: rt verify");
  console.log("");
}
