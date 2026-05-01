#!/usr/bin/env bun

/**
 * rt auto-fix — inspect and configure the daemon's auto-fix engine.
 *
 * Usage:
 *   rt auto-fix enable | disable   → toggle per-repo auto-fix
 *   rt auto-fix log [<branch>]      → recent attempts (date, branch, sha, outcome, duration)
 *   rt auto-fix notes <branch>      → most recent notes file for a branch
 *   rt auto-fix status              → enabled? recent attempts? lock holder?
 */

import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  loadAutoFixConfig, saveAutoFixConfig, autoFixConfigPath,
} from "../lib/auto-fix-config.ts";
import {
  readLog, readNotes, autoFixLogPath,
  type AutoFixLogEntry,
} from "../lib/auto-fix-log.ts";
import { isLockHeld, autoFixLockPath } from "../lib/auto-fix-lock.ts";
import { readFileSync } from "fs";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── enable / disable ────────────────────────────────────────────────────────

export async function enableCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const cfg = loadAutoFixConfig(repoName);
  if (cfg.enabled) {
    console.log(`\n  ${dim}auto-fix already enabled for${reset} ${bold}${repoName}${reset}\n`);
    return;
  }
  saveAutoFixConfig(repoName, { ...cfg, enabled: true });
  console.log(`\n  ${green}✓${reset} auto-fix ${green}enabled${reset} for ${bold}${repoName}${reset}`);
  console.log(`    ${dim}config: ${autoFixConfigPath(repoName)}${reset}\n`);
}

export async function disableCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const cfg = loadAutoFixConfig(repoName);
  if (!cfg.enabled) {
    console.log(`\n  ${dim}auto-fix already disabled for${reset} ${bold}${repoName}${reset}\n`);
    return;
  }
  saveAutoFixConfig(repoName, { ...cfg, enabled: false });
  console.log(`\n  ${yellow}○${reset} auto-fix ${yellow}disabled${reset} for ${bold}${repoName}${reset}\n`);
}

// ─── log ────────────────────────────────────────────────────────────────────

export async function logCommand(args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const branchFilter = args[0];
  let entries = readLog(repoName);
  if (branchFilter) entries = entries.filter(e => e.branch === branchFilter);

  if (entries.length === 0) {
    console.log(`\n  ${dim}no auto-fix attempts${branchFilter ? ` for ${branchFilter}` : ""} yet${reset}`);
    console.log(`  ${dim}log file: ${autoFixLogPath(repoName)}${reset}\n`);
    return;
  }

  const widestBranch = Math.max(...entries.map(e => e.branch.length));
  console.log(`\n  ${bold}${cyan}rt auto-fix log${reset} ${dim}(${repoName})${reset}\n`);
  for (const e of entries) {
    const when = new Date(e.attemptedAt).toISOString().replace("T", " ").slice(0, 19);
    const icon = outcomeIcon(e.outcome);
    const sha = e.sha.slice(0, 8);
    console.log(`  ${dim}${when}${reset}  ${icon}  ${e.branch.padEnd(widestBranch)}  ${dim}${sha}${reset}  ${formatOutcome(e)}`);
  }
  console.log("");
}

function outcomeIcon(outcome: AutoFixLogEntry["outcome"]): string {
  if (outcome === "fixed")         return `${green}✓${reset}`;
  if (outcome === "skipped")       return `${dim}—${reset}`;
  if (outcome === "rejected_diff") return `${yellow}~${reset}`;
  return `${red}✗${reset}`;
}

function formatOutcome(e: AutoFixLogEntry): string {
  const dur = `${dim}(${Math.round(e.durationMs / 1000)}s)${reset}`;
  if (e.outcome === "fixed")
    return `${green}fixed${reset} ${e.commitSha?.slice(0, 8) ?? ""} ${dur}  ${e.reason ?? ""}`;
  if (e.outcome === "skipped")
    return `${dim}skipped${reset} ${dur}  ${e.reason ?? ""}`;
  if (e.outcome === "rejected_diff")
    return `${yellow}rejected${reset} ${dur}  ${e.reason ?? ""}`;
  return `${red}error${reset} ${dur}  ${e.reason ?? ""}`;
}

// ─── notes ──────────────────────────────────────────────────────────────────

export async function notesCommand(args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const branch = args[0];
  if (!branch) {
    console.log(`\n  ${red}usage: rt auto-fix notes <branch>${reset}\n`);
    process.exit(1);
  }

  const entries = readLog(repoName).filter(e => e.branch === branch);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const body = readNotes(repoName, e.branch, e.sha);
    if (body !== null) {
      console.log(`\n  ${bold}${cyan}rt auto-fix notes${reset} ${dim}(${branch} @ ${e.sha.slice(0, 8)})${reset}\n`);
      console.log(body);
      return;
    }
  }
  console.log(`\n  ${dim}no notes for${reset} ${bold}${branch}${reset}\n`);
}

// ─── status ─────────────────────────────────────────────────────────────────

export async function statusCommand(_args: string[], ctx: CommandContext): Promise<void> {
  const repoName = ctx.identity!.repoName;
  const cfg = loadAutoFixConfig(repoName);
  const recentEntries = readLog(repoName).slice(-5);
  const locked = isLockHeld(repoName);

  console.log(`\n  ${bold}${cyan}rt auto-fix status${reset} ${dim}(${repoName})${reset}\n`);
  console.log(`    ${cfg.enabled ? `${green}●${reset}` : `${dim}○${reset}`} auto-fix ${cfg.enabled ? `${green}enabled${reset}` : `${dim}disabled${reset}`}`);
  console.log(`    ${dim}caps: ≤${cfg.fileCap} files, ≤${cfg.lineCap} lines${reset}`);
  if (cfg.allowTestFixes) console.log(`    ${dim}test failures: in scope${reset}`);
  if (cfg.additionalDenylist.length > 0) {
    console.log(`    ${dim}additional denylist: ${cfg.additionalDenylist.join(", ")}${reset}`);
  }
  if (locked) {
    try {
      const body = JSON.parse(readFileSync(autoFixLockPath(repoName), "utf8"));
      console.log(`    ${yellow}⚙${reset}  ${yellow}fix in flight${reset}: ${body.branch}@${String(body.sha).slice(0, 8)} (pid ${body.pid})`);
    } catch {
      console.log(`    ${yellow}⚙${reset}  fix in flight (lock file unreadable)`);
    }
  }
  console.log("");

  if (recentEntries.length === 0) {
    console.log(`  ${dim}no recent attempts${reset}\n`);
    return;
  }
  console.log(`  ${bold}recent attempts:${reset}`);
  const widestBranch = Math.max(...recentEntries.map(e => e.branch.length));
  for (const e of recentEntries) {
    const when = new Date(e.attemptedAt).toISOString().replace("T", " ").slice(0, 19);
    console.log(`    ${dim}${when}${reset}  ${outcomeIcon(e.outcome)}  ${e.branch.padEnd(widestBranch)}  ${formatOutcome(e)}`);
  }
  console.log("");
}
