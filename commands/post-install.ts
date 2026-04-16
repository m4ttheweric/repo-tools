/**
 * rt --post-install — First-run setup, auto-triggered on the first `rt` invocation.
 *
 * Handles all setup steps:
 *   1. Copy rt-tray.app → ~/Applications (remove quarantine)
 *   2. Install rt-context.vsix into all detected editors (best-effort, non-interactive)
 *   3. Install daemon as a launchd agent (auto-starts on login)
 *   4. Write shell integration to the user's rc file (PATH + rtcd, idempotent)
 *
 * Keeping this in the binary (not the formula) means:
 *   - Setup logic is versioned alongside the binary
 *   - Easy to test locally: rt --post-install
 *   - No Ruby needed to understand or change setup behaviour
 *   - Works correctly for both fresh install and upgrade
 */

import { spawnSync } from "child_process";
import { existsSync, readdirSync, mkdirSync, rmSync, cpSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { installShellIntegration } from "../lib/shell-integration.ts";

const HOME = homedir();

function log(icon: string, label: string, detail = ""): void {
  const detailStr = detail ? `  ${detail}` : "";
  console.log(`  ${icon} ${label}${detailStr}`);
}

function ok(label: string, detail = "")  { log("✓", label, detail); }
function fail(label: string, detail = "") { log("✗", label, detail); }
function info(label: string, detail = "") { log("·", label, detail); }

// ─── 1. Tray app ──────────────────────────────────────────────────────────────

function installTrayApp(): void {
  // The tray app is bundled alongside the rt binary in the Homebrew prefix.
  // Homebrew Cellar structure: .../cellar/rt/<version>/bin/rt
  //                                                   /../rt-tray.app
  const rtPath = process.execPath;
  const candidates = [
    resolve(rtPath, "../rt-tray.app"),           // same dir as binary
    resolve(rtPath, "../../rt-tray.app"),         // one level up (Cellar layout)
  ];

  const srcTray = candidates.find(existsSync);
  if (!srcTray) {
    fail("rt-tray.app", "not found alongside binary — skipping");
    return;
  }

  const appsDir = join(HOME, "Applications");
  const destTray = join(appsDir, "rt-tray.app");

  try {
    // Quit any running instance first — `open` on a running app just activates
    // the existing process and never boots the newly-copied binary.
    spawnSync("osascript", ["-e", 'tell application "rt-tray" to quit'], { stdio: "pipe", timeout: 3_000 });
    spawnSync("pkill", ["-x", "rt-tray"], { stdio: "pipe" });

    mkdirSync(appsDir, { recursive: true });
    if (existsSync(destTray)) rmSync(destTray, { recursive: true, force: true });
    cpSync(srcTray, destTray, { recursive: true });

    // Remove quarantine so macOS doesn't block launch
    spawnSync("xattr", ["-cr", destTray], { stdio: "pipe" });

    ok("rt-tray.app", `→ ~/Applications/rt-tray.app`);
  } catch (err: any) {
    fail("rt-tray.app", err?.message ?? String(err));
  }
}

// ─── 2. Extension ─────────────────────────────────────────────────────────────

const EDITOR_PATTERNS = [
  { appName: "Cursor.app",                        cliBinary: "cursor",      displayName: "Cursor" },
  { appName: "Cursor Personal.app",               cliBinary: "cursor",      displayName: "Cursor Personal" },
  { appName: "Visual Studio Code.app",            cliBinary: "code",        displayName: "VS Code" },
  { appName: "Visual Studio Code - Insiders.app", cliBinary: "code-insiders", displayName: "VS Code Insiders" },
  { appName: "VSCodium.app",                      cliBinary: "codium",      displayName: "VSCodium" },
  { appName: "Antigravity.app",                   cliBinary: "antigravity", displayName: "Antigravity" },
  { appName: "Windsurf.app",                      cliBinary: "windsurf",    displayName: "Windsurf" },
];

function findVsix(): string | null {
  const rtPath = process.execPath;
  for (const candidate of [
    resolve(rtPath, "../rt-context.vsix"),
    resolve(rtPath, "../../rt-context.vsix"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function installExtensions(): void {
  const vsix = findVsix();
  if (!vsix) {
    info("rt-context.vsix", "not found in Homebrew prefix — skipping");
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

      try {
        spawnSync(cliPath, ["--install-extension", vsix, "--force"], {
          stdio: "pipe",
          timeout: 30_000,
        });
        ok(`rt-context → ${pattern.displayName}`);
        installedCount++;
      } catch {
        fail(`rt-context → ${pattern.displayName}`, "install failed");
      }
    }
  }

  if (installedCount === 0) {
    info("rt-context", "no compatible editors found (install later: rt settings extension)");
  }
}

// ─── 3. Daemon ────────────────────────────────────────────────────────────────

async function installDaemon(): Promise<void> {
  try {
    const result = spawnSync(process.execPath, ["daemon", "install"], {
      stdio: "pipe",
      timeout: 15_000,
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
    info("daemon", "will start when rt-tray launches");
  } catch (err: any) {
    fail("daemon", err?.message ?? String(err));
  }
}


// ─── 4. Shell integration ─────────────────────────────────────────────────────────

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

// ─── 5. TCC / Full Disk Access check ─────────────────────────────────────────

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

    const { getDaemonConfig } = await import("../lib/daemon-config.ts");
    const config = getDaemonConfig();
    if (config?.mode === "tray") {
      console.log("");
      console.log("  Try restarting the tray app: quit rt-tray and reopen it.");
      console.log("  The daemon inherits TCC grants from the tray app.");
    } else {
      console.log("");
      console.log("  The rt daemon needs Full Disk Access to read your repos.");
      console.log("  Opening System Settings — add the 'rt' binary shown below:\n");
      const rtPath = ["/opt/homebrew/bin/rt", "/usr/local/bin/rt"].find(existsSync)
        ?? "/opt/homebrew/bin/rt";
      console.log(`    ${rtPath}\n`);
      spawnSync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"], { stdio: "pipe" });
    }
  } catch { /* daemon not reachable — skip silently */ }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

/**
 * Returns true when running inside the Homebrew post_install sandbox.
 * The sandbox blocks writes to ~/Applications, ~/.rt/, ~/.zshrc, etc.
 * Extensions still work because they're installed via signed app subprocesses.
 */
function isHomebrewSandboxed(): boolean {
  // Homebrew sets these env vars during formula post_install
  return !!(process.env.HOMEBREW_CELLAR || process.env.HOMEBREW_PREFIX) &&
    process.env.HOME !== undefined &&
    // If we can't write to HOME, we're sandboxed
    (() => {
      try {
        const testPath = join(homedir(), ".rt");
        mkdirSync(testPath, { recursive: true });
        return false; // write worked — not sandboxed
      } catch {
        return true; // EPERM — sandboxed
      }
    })();
}

export async function runPostInstall(): Promise<void> {
  console.log("");
  console.log("  rt post-install");
  console.log("");

  const sandboxed = isHomebrewSandboxed();

  if (sandboxed) {
    // Only install extensions — they work via signed app subprocesses.
    // Home-directory writes (tray, daemon, shell) are blocked by the sandbox.
    info("sandbox", "Homebrew sandbox detected — installing extensions only");
    installExtensions();
    console.log("");
    console.log("  Run the following to complete setup:");
    console.log("    rt --post-install");
    console.log("");
    return;
  }

  installTrayApp();
  installExtensions();
  await installDaemon();
  installShellIntegrationStep();

  const trayDest = join(HOME, "Applications", "rt-tray.app");
  if (existsSync(trayDest)) {
    spawnSync("open", [trayDest], { stdio: "pipe" });
    ok("rt-tray.app", "launched");
  }

  await checkTccAccess();

  console.log("");
  console.log("  Done. Restart your terminal, then run: rt doctor");
  console.log("");
}
