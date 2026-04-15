#!/usr/bin/env bun

/**
 * rt update — Upgrade rt to the latest version via Homebrew.
 *
 * Equivalent to: brew upgrade m4ttheweric/tap/rt
 */

import { spawnSync, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";

declare const RT_VERSION: string;

export async function runUpdate(_args: string[]): Promise<void> {
  // Detect dev mode — updating makes no sense when running from source.
  // Use the wrapper script as the authoritative signal (same as settings.ts:currentMode()).
  // dev-mode.json persists even after switching to prod, so it's not reliable.
  const devModeWrapper = join(homedir(), ".local/bin/rt");
  if (existsSync(devModeWrapper)) {
    console.log(`\n  ${yellow}⚠${reset}  dev mode is active — you're running from local source.`);
    console.log(`  ${dim}Switch to prod first: rt settings dev-mode prod${reset}\n`);
    process.exit(1);
  }

  // Check brew is available
  const brew = spawnSync("which", ["brew"], { encoding: "utf8" }).stdout.trim();
  if (!brew) {
    console.log(`\n  ${red}✗${reset}  Homebrew not found — rt was not installed via Homebrew.`);
    console.log(`  ${dim}Install from: https://brew.sh${reset}\n`);
    process.exit(1);
  }

  // Show current version — RT_VERSION is injected at compile time via bun build --define.
  const current = (typeof RT_VERSION !== "undefined" ? RT_VERSION : null) ?? process.env.RT_VERSION ?? "dev";
  console.log(`\n  ${bold}${cyan}rt update${reset}\n`);
  console.log(`  ${dim}current: ${current}${reset}`);

  // Check if there's an update available first (non-blocking)
  try {
    execSync("brew update --quiet", { stdio: "pipe", timeout: 30_000 });
    const outdated = execSync("brew outdated m4ttheweric/tap/rt 2>/dev/null || brew outdated rt 2>/dev/null", {
      encoding: "utf8", stdio: "pipe",
    }).trim();

    if (!outdated) {
      console.log(`  ${green}✓${reset}  already up to date\n`);
      return;
    }
  } catch {
    // brew update can fail (no network etc.) — attempt upgrade anyway
  }

  console.log(`  upgrading via Homebrew…\n`);

  const result = spawnSync(brew, ["upgrade", "m4ttheweric/tap/rt"], {
    stdio: "inherit",
    timeout: 5 * 60_000,
  });

  if (result.status !== 0) {
    // Try without the tap prefix in case it's already linked differently
    const fallback = spawnSync(brew, ["upgrade", "rt"], { stdio: "inherit", timeout: 5 * 60_000 });
    if (fallback.status !== 0) {
      console.log(`\n  ${red}✗${reset}  upgrade failed — run manually: brew upgrade m4ttheweric/tap/rt\n`);
      process.exit(1);
    }
  }

  console.log(`\n  ${green}✓${reset}  rt updated — restart your terminal for the new version\n`);
}
