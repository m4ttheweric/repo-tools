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

import { execSync } from "child_process";
import { existsSync } from "fs";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
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

// ─── rt doppler sync ─────────────────────────────────────────────────────────

/**
 * Walk this repo's worktrees and apply the template to each. Identical logic
 * to the daemon's per-tick reconciliation, surfaced as a CLI command for
 * on-demand runs (e.g. just after `rt doppler init`, or when the daemon is
 * down).
 */
export async function syncCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const { reconcileForRepo } = await import("../lib/daemon/doppler-sync.ts");
  const repoName = ctx.identity!.repoName;
  const repoRoot = ctx.identity!.repoRoot;

  if (!existsSync(templatePath(repoName))) {
    console.log(`\n  ${red}no template at${reset} ${dim}${templatePath(repoName)}${reset}`);
    console.log(`  ${dim}run${reset} ${bold}rt doppler init${reset} ${dim}first${reset}\n`);
    process.exit(1);
  }

  const worktreeRoots = listWorktreeRoots(repoRoot);
  console.log(`\n  ${bold}${cyan}rt doppler sync${reset} ${dim}(${worktreeRoots.length} worktrees)${reset}`);
  for (const w of worktreeRoots) {
    console.log(`    ${dim}- ${w}${reset}`);
  }

  const summary = await reconcileForRepo({ repoName, worktreeRoots });

  if (summary.skipped === "malformed-template") {
    console.log(`\n  ${red}template is malformed — fix with rt doppler edit${reset}\n`);
    process.exit(1);
  }
  if (summary.skipped === "no-template") {
    console.log(`\n  ${red}no template — run rt doppler init${reset}\n`);
    process.exit(1);
  }

  console.log(`\n  ${green}✓${reset} wrote ${bold}${summary.wrote}${reset} entries`);
  console.log(`    ${dim}${summary.unchanged} unchanged, ${summary.overridden} overridden${reset}\n`);
}

/**
 * Enumerate this repo's worktree roots via `git worktree list --porcelain`.
 * Returns absolute paths.
 */
function listWorktreeRoots(repoRoot: string): string[] {
  const out = execSync("git worktree list --porcelain", {
    cwd: repoRoot, encoding: "utf8", stdio: "pipe",
  });
  const roots: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      roots.push(line.slice("worktree ".length).trim());
    }
  }
  return roots;
}
