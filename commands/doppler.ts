#!/usr/bin/env bun

/**
 * rt doppler — manage per-repo Doppler templates and sync them into
 * `~/.doppler/.doppler.yaml`.
 *
 * Usage:
 *   rt doppler init    → capture existing entries from ~/.doppler/.doppler.yaml
 *                         into ~/.rt/<repo>/doppler-template.yaml
 *   rt doppler sync    → reconcile ~/.doppler/.doppler.yaml against the template
 *                         + current worktrees
 *   rt doppler status  → show: which template entries are present, missing,
 *                         or overridden in ~/.doppler/.doppler.yaml
 *   rt doppler edit    → open the template in $EDITOR
 *
 * See docs/superpowers/specs/2026-04-30-doppler-template-sync-design.md.
 */

import { existsSync } from "fs";
import { bold, cyan, dim, green, reset, yellow } from "../lib/tui.ts";
import {
  captureFromActualConfig, loadTemplate, saveTemplate, templatePath,
} from "../lib/doppler-template.ts";
import { loadDopplerConfig } from "../lib/doppler-config.ts";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── rt doppler init ─────────────────────────────────────────────────────────

export async function initCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const repoRoot = ctx.identity!.repoRoot;

  const dopplerCfg = loadDopplerConfig();
  const captured = captureFromActualConfig(dopplerCfg, repoRoot);

  if (captured.length === 0) {
    console.log(`\n  ${yellow}no enclave entries found under${reset} ${dim}${repoRoot}${reset}`);
    console.log(`  ${dim}run \`make initDoppler\` (or your repo's equivalent) at least once first${reset}\n`);
    process.exit(1);
  }

  const path = templatePath(repoName);
  if (existsSync(path)) {
    const existing = loadTemplate(repoName) ?? [];
    if (JSON.stringify(existing) === JSON.stringify(captured)) {
      console.log(`\n  ${dim}template already up to date (${captured.length} entries)${reset}`);
      console.log(`  ${dim}${path}${reset}\n`);
      return;
    }
    console.log(`\n  ${yellow}template exists at${reset} ${dim}${path}${reset}`);
    console.log(`  ${yellow}overwriting with ${captured.length} captured entries${reset}\n`);
  }

  saveTemplate(repoName, captured);

  console.log(`\n  ${green}✓${reset} captured ${bold}${captured.length}${reset} entries into ${dim}${path}${reset}`);
  for (const e of captured) {
    console.log(`    ${cyan}${e.path}${reset}  ${dim}→${reset}  ${e.project}/${e.config}`);
  }
  console.log(`\n  ${dim}run${reset} ${bold}rt doppler sync${reset} ${dim}to apply across all worktrees${reset}\n`);
}
