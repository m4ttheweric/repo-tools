/**
 * rt settings extension — Install the RT Context extension in local editors.
 *
 * Detects VS Code-compatible editors by scanning /Applications and ~/Applications
 * for .app bundles that contain `bin/code` or similar CLI wrappers. Shows a fuzzy
 * picker to let the user choose which editors to install into.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { detectEditors } from "../lib/editors.ts";

// ─── VSIX Finder ─────────────────────────────────────────────────────────────

function findVsix(): string | null {
  // 1. Next to the binary (extracted release tarball layout)
  const execPath = process.execPath;
  const bundledVsix = resolve(execPath, "../rt-context.vsix");
  if (existsSync(bundledVsix)) return bundledVsix;

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
    console.log(`  ${dim}expected next to the rt binary or in extensions/vscode/rt-context/${reset}\n`);
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
  const { filterableMultiselect } = await import("../lib/pick-wrappers.ts");

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
