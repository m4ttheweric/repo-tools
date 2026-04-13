#!/usr/bin/env bun
/**
 * sync-workspace — Sync a .code-workspace file across worktrees.
 *
 * Copies the current workspace file to every sibling worktree,
 * preserving the target's peacock.color and workbench.colorCustomizations.
 *
 * Usage:
 *   bun scripts/sync-workspace.ts <workspace-file>
 *   rt x sync-workspace   (if wired up)
 *
 * Example:
 *   bun scripts/sync-workspace.ts ./assured-dev.matt.code-workspace
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { basename, dirname, resolve, join } from "path";

// ── Parse args ──────────────────────────────────────────────────────────────

const sourceFile = process.argv[2];
if (!sourceFile) {
  console.error("Usage: bun scripts/sync-workspace.ts <workspace-file>");
  process.exit(1);
}

const absSource = resolve(sourceFile);
if (!existsSync(absSource)) {
  console.error(`File not found: ${absSource}`);
  process.exit(1);
}

const fileName = basename(absSource);
const sourceDir = dirname(absSource);

// ── Parse JSONC (strip comments) ────────────────────────────────────────────

function parseJsonc(text: string): any {
  // Strip single-line comments (// ...) and block comments (/* ... */)
  const stripped = text
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(stripped);
}

// ── Discover worktrees ──────────────────────────────────────────────────────

function getWorktrees(cwd: string): string[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd,
      encoding: "utf8",
    });
    return output
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace("worktree ", "").trim());
  } catch {
    console.error("Failed to list worktrees. Are you in a git repo?");
    process.exit(1);
  }
}

// ── Peacock keys to preserve ────────────────────────────────────────────────

const PRESERVE_KEYS = [
  "peacock.color",
  "peacock.favoriteColors",
  "workbench.colorCustomizations",
];

// ── Main ────────────────────────────────────────────────────────────────────

const source = parseJsonc(readFileSync(absSource, "utf8"));
const worktrees = getWorktrees(sourceDir);

let synced = 0;
let skipped = 0;

for (const wt of worktrees) {
  if (wt === sourceDir) continue; // skip self

  const targetPath = join(wt, fileName);
  if (!existsSync(targetPath)) {
    console.log(`  skip  ${targetPath} (no matching file)`);
    skipped++;
    continue;
  }

  // Read target and extract peacock settings
  let target: any;
  try {
    target = parseJsonc(readFileSync(targetPath, "utf8"));
  } catch (e) {
    console.log(`  skip  ${targetPath} (parse error)`);
    skipped++;
    continue;
  }

  const preserved: Record<string, any> = {};
  for (const key of PRESERVE_KEYS) {
    if (target.settings?.[key] !== undefined) {
      preserved[key] = target.settings[key];
    }
  }

  // Deep-clone source and overlay preserved keys
  const merged = JSON.parse(JSON.stringify(source));
  for (const [key, value] of Object.entries(preserved)) {
    merged.settings[key] = value;
  }

  // Write with clean formatting
  writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n");

  const color = preserved["peacock.color"] || "no color";
  console.log(`  sync  ${basename(wt)} → ${fileName}  (kept ${color})`);
  synced++;
}

console.log(`\n  Done: ${synced} synced, ${skipped} skipped\n`);
