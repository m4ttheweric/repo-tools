#!/usr/bin/env bun

/**
 * rt workspace sync — Auto-sync .code-workspace files across worktrees.
 *
 * First run:
 *   - Scans all worktrees for .code-workspace files
 *   - Picks the most recently modified as the initial source
 *   - Shows what will happen, asks for Enter to confirm
 *   - Syncs to all other worktrees (preserving peacock colors)
 *   - Registers a daemon watcher for automatic future syncs
 *
 * Subsequent runs:
 *   - Triggers an immediate sync + shows status
 *
 * Flags:
 *   --status  show current sync config and watcher state
 *   --off     disable syncing and remove file watcher
 */

import { existsSync, readdirSync, statSync, readFileSync } from "fs";
import { join, basename, dirname } from "path";
import { execSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { getRepoIdentity, requireIdentity } from "../lib/repo.ts";
import { daemonQuery } from "../lib/daemon-client.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWorktreePaths(repoPath: string): string[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: repoPath,
      encoding: "utf8",
      stdio: "pipe",
    });
    return output
      .split("\n")
      .filter(l => l.startsWith("worktree "))
      .map(l => l.replace("worktree ", "").trim());
  } catch {
    return [repoPath];
  }
}

function parseJsonc(text: string): any {
  const stripped = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(stripped);
}

function getPeacockColor(filePath: string): string | null {
  try {
    const content = parseJsonc(readFileSync(filePath, "utf8"));
    return content?.settings?.["peacock.color"] || null;
  } catch {
    return null;
  }
}

function colorDot(hex: string | null): string {
  if (!hex) return `${dim}●${reset}`;
  // Parse hex to ANSI 24-bit color
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m●${reset}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ─── Export: workspaceSyncCommand ────────────────────────────────────────────

export async function workspaceSyncCommand(): Promise<void> {
  const identity = await requireIdentity("rt workspace sync");
  const { repoName, repoRoot } = identity;
  const flags = process.argv.slice(2).filter(a => a.startsWith("--"));

  // ── --off: disable ──────────────────────────────────────────────────────
  if (flags.includes("--off")) {
    const result = await daemonQuery("workspace:sync:stop", { repo: repoName });
    if (result?.ok) {
      console.log(`\n  ${green}✓${reset} Stopped watching workspace file for ${bold}${repoName}${reset}\n`);
    } else {
      console.log(`\n  ${red}✗${reset} Failed to stop: ${result?.error || "daemon not available"}\n`);
    }
    return;
  }

  // ── --status: show state ──────────────────────────────────────────────────
  if (flags.includes("--status")) {
    const result = await daemonQuery("workspace:sync:status", { repo: repoName });
    if (!result?.ok || !result.data?.config) {
      console.log(`\n  ${dim}No workspace sync configured for ${repoName}${reset}\n`);
      return;
    }

    const { config, active, watcherCount } = result.data;
    const worktrees = getWorktreePaths(repoRoot);

    console.log(`\n  ${bold}${cyan}rt workspace sync${reset}\n`);
    console.log(`  File:    ${bold}${config.fileName}${reset}`);
    console.log(`  Repo:    ${repoName}`);
    console.log(`  Watcher: ${active ? `${green}active${reset} (${watcherCount} worktrees)` : `${red}stopped${reset}`}`);
    if (config.lastSyncAt) {
      console.log(`  Last:    ${timeAgo(config.lastSyncAt)} from ${basename(config.lastSyncSource || "unknown")}`);
    }

    console.log(`\n  Worktrees:`);
    const cwd = process.cwd();
    for (const wt of worktrees) {
      const filePath = join(wt, config.fileName);
      const color = getPeacockColor(filePath);
      const isHere = cwd.startsWith(wt);
      console.log(`    ${basename(wt).padEnd(20)} ${colorDot(color)} ${color || dim + "no color" + reset}${isHere ? `  ${dim}(you are here)${reset}` : ""}`);
    }
    console.log();
    return;
  }

  // ── Main: init or re-sync ─────────────────────────────────────────────────

  // Check if already configured
  const existing = await daemonQuery("workspace:sync:status", { repo: repoName });
  const isConfigured = existing?.ok && existing.data?.config?.enabled;

  const worktrees = getWorktreePaths(repoRoot);

  if (isConfigured) {
    // Already configured — just trigger a sync
    const config = existing!.data!.config;
    console.log(`\n  ${bold}${cyan}rt workspace sync${reset}\n`);
    console.log(`  Syncing ${bold}${config.fileName}${reset}...`);

    const result = await daemonQuery("workspace:sync:trigger", { repo: repoName });
    if (result?.ok) {
      const { synced, results } = result.data || { synced: 0, results: [] };
      console.log(`  ${green}✓${reset} ${synced} worktree(s) synced (peacock preserved)\n`);
      for (const r of results) {
        console.log(`    ${basename(r.path).padEnd(20)} ${colorDot(r.color)} ${r.color || ""}`);
      }
    } else {
      console.log(`  ${red}✗${reset} Sync failed: ${result?.error || "daemon not available"}`);
    }
    console.log();
    return;
  }

  // ── First-time init ──────────────────────────────────────────────────────
  console.log(`\n  ${bold}${cyan}rt workspace sync${reset}\n`);

  // Find all workspace files across all worktrees, pick the most recent
  interface Candidate {
    filePath: string;
    worktree: string;
    fileName: string;
    mtime: Date;
  }

  let latest: Candidate | null = null;
  const allFiles = new Map<string, Candidate[]>(); // fileName → candidates

  for (const wt of worktrees) {
    try {
      const files = readdirSync(wt).filter(f => f.endsWith(".code-workspace"));
      for (const f of files) {
        const filePath = join(wt, f);
        try {
          const stat = statSync(filePath);
          const candidate: Candidate = { filePath, worktree: wt, fileName: f, mtime: stat.mtime };

          if (!allFiles.has(f)) allFiles.set(f, []);
          allFiles.get(f)!.push(candidate);

          if (!latest || stat.mtime > latest.mtime) {
            latest = candidate;
          }
        } catch { /* stat failed */ }
      }
    } catch { /* readdir failed */ }
  }

  if (!latest) {
    console.log(`  ${red}No .code-workspace files found${reset} in any worktree.\n`);
    return;
  }

  // Show what we found
  const candidates = allFiles.get(latest.fileName) || [];
  const otherWorktrees = worktrees.filter(wt => wt !== latest!.worktree);

  console.log(`  Most recent: ${bold}${latest.fileName}${reset}`);
  console.log(`    Source: ${bold}${basename(latest.worktree)}${reset}  ${dim}(modified ${timeAgo(latest.mtime.toISOString())})${reset}\n`);

  console.log(`  Will sync to:`);
  for (const wt of otherWorktrees) {
    const filePath = join(wt, latest.fileName);
    const color = existsSync(filePath) ? getPeacockColor(filePath) : null;
    const exists = existsSync(filePath);
    console.log(`    ${basename(wt).padEnd(20)} ${colorDot(color)} ${color || ""}${!exists ? ` ${dim}(will create)${reset}` : ""}`);
  }

  console.log(`\n  ${dim}Peacock colors will be preserved in each worktree.${reset}`);
  console.log(`  ${dim}Future edits in any worktree will auto-sync to all others.${reset}\n`);

  // Wait for Enter
  if (process.stdin.isTTY) {
    process.stdout.write(`  Press ${bold}Enter${reset} to sync, ${bold}Ctrl+C${reset} to cancel: `);
    await new Promise<void>((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once("data", (data) => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        const char = data[0];
        if (char === 3 || char === 27) {
          // Ctrl+C or Escape
          console.log(`\n\n  ${dim}Cancelled. Make your edits and run again.${reset}\n`);
          process.exit(0);
        }
        console.log(); // newline after Enter
        resolve();
      });
    });
  }

  // Do the initial sync + register with daemon
  const result = await daemonQuery("workspace:sync:start", {
    repo: repoName,
    repoPath: repoRoot,
    fileName: latest.fileName,
    sourcePath: latest.filePath,
  });

  if (result?.ok) {
    const { synced, results } = result.data || { synced: 0, results: [] };
    console.log(`  ${green}✓${reset} Watching ${bold}${latest.fileName}${reset}`);
    console.log(`  ${green}✓${reset} Added to .git/info/exclude`);
    console.log(`  ${green}✓${reset} Synced to ${synced} worktree(s) (peacock preserved)\n`);
    for (const r of results) {
      console.log(`    ${basename(dirname(r.path)).padEnd(20)} ${colorDot(r.color)} ${r.color || ""}`);
    }
  } else {
    console.log(`  ${red}✗${reset} Failed: ${result?.error || "daemon not available"}`);
    console.log(`  ${dim}Make sure the daemon is running: rt daemon start${reset}`);
  }

  console.log();
}

