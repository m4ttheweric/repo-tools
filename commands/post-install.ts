/**
 * rt --post-install — Run automatically by the Homebrew formula after install/upgrade.
 *
 * Handles all setup that would otherwise live in the formula's post_install block:
 *   1. Copy rt-tray.app → ~/Applications (remove quarantine)
 *   2. Install rt-context.vsix into all detected editors (best-effort, non-interactive)
 *   3. Install daemon as a launchd agent (auto-starts on login)
 *   4. Write shell integration to ~/.zshrc (PATH + rtcd alias, idempotent)
 *
 * Keeping this in the binary (not the formula) means:
 *   - Setup logic is versioned alongside the binary
 *   - Easy to test locally: rt --post-install
 *   - No Ruby needed to understand or change setup behaviour
 *   - Works correctly for both fresh install and upgrade
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

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
    const { markDaemonInstalled, isDaemonInstalled, LAUNCHD_PLIST_PATH, LAUNCHD_LABEL } =
      await import("../lib/daemon-config.ts");
    const { isDaemonRunning } = await import("../lib/daemon-client.ts");

    const rtPath = process.execPath;

    // Always re-mark installed on upgrade (ensures binary path stays current)
    markDaemonInstalled(rtPath, "--daemon", "launchd");

    // Write fresh plist
    const { generatePlist } = await import("../commands/daemon.ts") as any;
    if (typeof generatePlist === "function") {
      const plist = generatePlist(rtPath, undefined);
      mkdirSync(join(HOME, "Library/LaunchAgents"), { recursive: true });
      writeFileSync(LAUNCHD_PLIST_PATH, plist);
    }

    // Re-register with launchd (unload first to handle upgrades cleanly)
    try { execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: "pipe" }); } catch {}
    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`, { stdio: "pipe" });

    ok("daemon", "registered with launchd");

    // Wait briefly for it to start
    for (let i = 0; i < 8; i++) {
      await Bun.sleep(250);
      if (await isDaemonRunning()) { ok("daemon", "running"); return; }
    }
    info("daemon", "installed (will start on next login)");
  } catch (err: any) {
    fail("daemon", err?.message ?? String(err));
  }
}

// ─── 4. Shell integration ─────────────────────────────────────────────────────

function installShellIntegration(): void {
  const zshrc = join(HOME, ".zshrc");
  const marker = "# rt — repo tools";

  const existing = existsSync(zshrc) ? readFileSync(zshrc, "utf8") : "";
  if (existing.includes(marker)) {
    info("shell integration", "already configured in ~/.zshrc");
    return;
  }

  const block = [
    "",
    marker,
    'export PATH="$HOME/.local/bin:$PATH"',
    'rt-cd() { local dir=$(rt cd 2>/dev/null); [ -n "$dir" ] && cd "$dir"; }',
    "alias rtcd='rt-cd'",
    "",
  ].join("\n");

  try {
    writeFileSync(zshrc, existing + block);
    ok("shell integration", "added PATH + rtcd alias to ~/.zshrc");
  } catch (err: any) {
    fail("shell integration", err?.message ?? String(err));
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runPostInstall(): Promise<void> {
  console.log("");
  console.log("  rt post-install");
  console.log("");

  installTrayApp();
  installExtensions();
  await installDaemon();
  installShellIntegration();

  console.log("");
  console.log("  Done. Restart your terminal, then run: rt doctor");
  console.log("");
}
