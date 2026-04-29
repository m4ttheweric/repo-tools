/**
 * rt settings extension — Install the RT Context extension in local editors.
 *
 * Detects VS Code-compatible editors by scanning /Applications and ~/Applications
 * for .app bundles that contain `bin/code` or similar CLI wrappers. Shows a fuzzy
 * picker to let the user choose which editors to install into.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";

// ─── Editor Detection ────────────────────────────────────────────────────────

interface DetectedEditor {
  name: string;        // Display name (e.g. "Visual Studio Code")
  cliPath: string;     // Full path to the CLI binary
  appPath: string;     // Full path to the .app bundle
}

/**
 * Known VS Code-family editors and their expected CLI binary names.
 * We scan .app bundles in /Applications and ~/Applications for these.
 */
const EDITOR_PATTERNS: Array<{ appName: string; cliBinary: string; displayName: string }> = [
  { appName: "Cursor.app",               cliBinary: "cursor",      displayName: "Cursor" },
  { appName: "Cursor Personal.app",      cliBinary: "cursor",      displayName: "Cursor Personal" },
  { appName: "Visual Studio Code.app",   cliBinary: "code",        displayName: "Visual Studio Code" },
  { appName: "Visual Studio Code - Insiders.app", cliBinary: "code-insiders", displayName: "VS Code Insiders" },
  { appName: "VSCodium.app",             cliBinary: "codium",      displayName: "VSCodium" },
  { appName: "Antigravity.app",          cliBinary: "antigravity", displayName: "Antigravity" },
  { appName: "Windsurf.app",             cliBinary: "windsurf",    displayName: "Windsurf" },
];

const APP_DIRS = ["/Applications", join(homedir(), "Applications")];

function detectEditors(): DetectedEditor[] {
  const editors: DetectedEditor[] = [];

  for (const appDir of APP_DIRS) {
    if (!existsSync(appDir)) continue;

    let apps: string[];
    try {
      apps = readdirSync(appDir);
    } catch {
      continue;
    }

    for (const pattern of EDITOR_PATTERNS) {
      if (!apps.includes(pattern.appName)) continue;

      const appPath = join(appDir, pattern.appName);
      // VS Code-family editors store CLI in Contents/Resources/app/bin/<name>
      const cliPath = join(appPath, "Contents/Resources/app/bin", pattern.cliBinary);

      if (existsSync(cliPath)) {
        editors.push({
          name: pattern.displayName,
          cliPath,
          appPath,
        });
      }
    }
  }

  return editors;
}

// ─── VSIX Finder ─────────────────────────────────────────────────────────────

function findVsix(): string | null {
  // 1. Check Homebrew formula prefix (compiled binary install)
  const execPath = process.execPath;
  const brewPrefix = resolve(execPath, "..");
  const brewVsix = join(brewPrefix, "rt-context.vsix");
  if (existsSync(brewVsix)) return brewVsix;

  // Also check one level up (Homebrew Cellar structure: Cellar/rt/version/bin/rt)
  const cellarVsix = resolve(execPath, "../../rt-context.vsix");
  if (existsSync(cellarVsix)) return cellarVsix;

  // 2. Check relative to source repo (development mode only — skip in compiled binary)
  const metaUrl = new URL(import.meta.url).pathname;
  if (metaUrl.startsWith("/$bunfs")) return null; // compiled binary — no source access

  const sourceDir = resolve(metaUrl, "../../extensions/vscode/rt-context");
  if (!existsSync(sourceDir)) return null;

  const glob = new Bun.Glob("*.vsix");
  for (const match of glob.scanSync(sourceDir)) {
    return join(sourceDir, match);
  }

  // 3. Try building if source exists
  const pkgJson = join(sourceDir, "package.json");
  if (existsSync(pkgJson)) {
    try {
      console.log(`  ${dim}building extension from source…${reset}`);
      execSync("npm run package", { cwd: sourceDir, stdio: "pipe" });
      for (const match of glob.scanSync(sourceDir)) {
        return join(sourceDir, match);
      }
    } catch {
      // Build failed — fall through
    }
  }

  return null;
}

// ─── Install ─────────────────────────────────────────────────────────────────

export async function installExtension(): Promise<void> {
  // 1. Find the vsix
  const vsixPath = findVsix();
  if (!vsixPath) {
    console.log(`  ${red}✗${reset} rt-context.vsix not found`);
    console.log(`  ${dim}expected in Homebrew prefix or extensions/vscode/rt-context/${reset}\n`);
    return;
  }

  console.log(`  ${dim}vsix: ${vsixPath}${reset}\n`);

  // 2. Detect installed editors
  const editors = detectEditors();
  if (editors.length === 0) {
    console.log(`  ${yellow}no VS Code-compatible editors found${reset}`);
    console.log(`  ${dim}install Cursor, VS Code, Antigravity, or similar first${reset}\n`);
    return;
  }

  // 3. Show fuzzy picker for editor selection
  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const selected = await filterableMultiselect({
    message: "Select editors to install RT Context into",
    options: editors.map((e) => ({
      value: e.cliPath,
      label: e.name,
      hint: e.appPath,
    })),
  });

  if (!selected || selected.length === 0) {
    console.log(`\n  ${dim}no editors selected${reset}\n`);
    return;
  }

  console.log("");

  // 4. Install into each selected editor
  let installed = 0;
  for (const cliPath of selected) {
    const editor = editors.find((e) => e.cliPath === cliPath)!;

    try {
      execSync(`"${cliPath}" --install-extension "${vsixPath}" --force 2>&1`, {
        stdio: "pipe",
        timeout: 30_000,
      });
      console.log(`  ${green}✓${reset} rt-context installed (${editor.name})`);
      installed++;
    } catch (err: any) {
      const msg = err?.stderr?.toString?.()?.trim() || "unknown error";
      console.log(`  ${red}✗${reset} ${editor.name} — ${msg}`);
    }
  }

  if (installed > 0) {
    console.log(`\n  ${green}${bold}✓ installed${reset} ${dim}— restart your editor to activate${reset}`);
  }

  console.log("");
}
