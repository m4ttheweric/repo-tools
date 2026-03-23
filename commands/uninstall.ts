#!/usr/bin/env bun

/**
 * rt uninstall — Remove all rt footprint from the current repo.
 *
 * Reverts core.hooksPath to .husky, deletes ~/.rt/<repo>/ data directory
 * (config, presets, baselines, hooks, build history).
 *
 * Usage:
 *   rt uninstall          interactive confirm
 *   rt uninstall --force  skip confirmation
 */

import { existsSync, rmSync } from "fs";
import { execSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { requireIdentity } from "../lib/repo.ts";

export async function run(args: string[]): Promise<void> {
  const identity = await requireIdentity("rt uninstall");

  const { repoName, repoRoot, dataDir } = identity;
  const force = args.includes("--force") || args.includes("-f");

  // Check what exists
  const hasDataDir = existsSync(dataDir);
  let hooksRedirected = false;

  try {
    const hooksPath = execSync("git config core.hooksPath", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    hooksRedirected = hooksPath.includes(".rt");
  } catch { /* not set or error */ }

  if (!hasDataDir && !hooksRedirected) {
    console.log(`\n  ${dim}no rt footprint found for ${repoName}${reset}\n`);
    return;
  }

  // Show what will be removed
  console.log("");
  console.log(`  ${bold}${cyan}rt uninstall${reset}  ${dim}(${repoName})${reset}`);
  console.log("");

  if (hooksRedirected) {
    console.log(`  ${yellow}●${reset} restore core.hooksPath → .husky`);
  }
  if (hasDataDir) {
    console.log(`  ${yellow}●${reset} delete ~/.rt/${repoName}/`);
    console.log(`    ${dim}config, presets, baselines, hooks, build history${reset}`);
  }
  console.log("");

  // Confirm
  if (!force) {
    if (!process.stdin.isTTY) {
      console.log(`  ${yellow}use --force to skip confirmation${reset}\n`);
      process.exit(1);
    }

    const { confirm: inkConfirm } = await import("../lib/rt-render.tsx");
    const confirmed = await inkConfirm({
      message: "Remove all rt data for this repo?",
      initialValue: false,
    });

    if (!confirmed) {
      console.log(`\n  ${dim}cancelled${reset}\n`);
      process.exit(0);
    }
  }

  // Restore hooks
  if (hooksRedirected) {
    try {
      execSync('git config core.hooksPath ".husky"', {
        cwd: repoRoot,
        stdio: "pipe",
      });
      console.log(`  ${green}✓${reset} restored core.hooksPath → .husky`);
    } catch {
      console.log(`  ${red}✗${reset} failed to restore core.hooksPath`);
    }
  }

  // Delete data directory
  if (hasDataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      console.log(`  ${green}✓${reset} deleted ~/.rt/${repoName}/`);
    } catch (err) {
      console.log(`  ${red}✗${reset} failed to delete ~/.rt/${repoName}/: ${err}`);
    }
  }

  console.log(`\n  ${dim}all rt footprint removed for ${repoName}${reset}\n`);
}
