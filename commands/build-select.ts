#!/usr/bin/env bun

/**
 * rt build — Interactive turbo build selector.
 *
 * Select packages to build interactively with multi-select
 * and build history tracking.
 *
 * Adapted from matts-tools/build-select.ts, now powered by @inkjs/ui.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { bold, cyan, dim, green, yellow, reset } from "../lib/tui.ts";
import { getWorkspacePackages } from "../lib/repo.ts";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Package {
  name: string;
  path: string;
}

interface HistoryEntry {
  lastBuilt: number;
  count: number;
}

type History = Record<string, HistoryEntry>;

// ─── History ─────────────────────────────────────────────────────────────────

function historyPath(dataDir: string): string {
  return join(dataDir, "build-history.json");
}

function loadHistory(dataDir: string): History {
  try {
    return JSON.parse(readFileSync(historyPath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

function saveHistory(dataDir: string, selectedNames: string[]): void {
  const history = loadHistory(dataDir);
  const now = Date.now();
  for (const name of selectedNames) {
    history[name] = {
      lastBuilt: now,
      count: (history[name]?.count ?? 0) + 1,
    };
  }
  writeFileSync(historyPath(dataDir), JSON.stringify(history, null, 2));
}

// ─── Package discovery ───────────────────────────────────────────────────────

function getPackages(root: string): Package[] {
  return getWorkspacePackages(root)
    .filter((p) => p.path.startsWith("packages/"))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Interactive selector ────────────────────────────────────────────────────

async function selectPackages(root: string, dataDir: string): Promise<string[] | null> {
  const packages = getPackages(root);

  if (packages.length === 0) {
    console.log(`${yellow}no packages found${reset}`);
    process.exit(1);
  }

  const history = loadHistory(dataDir);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // Sort: recent packages first, then alphabetical
  const sortedPackages = [...packages].sort((a, b) => {
    const aRecent = (history[a.name]?.lastBuilt ?? 0) > cutoff;
    const bRecent = (history[b.name]?.lastBuilt ?? 0) > cutoff;
    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;
    if (aRecent && bRecent) {
      return (history[b.name]?.lastBuilt ?? 0) - (history[a.name]?.lastBuilt ?? 0);
    }
    return a.path.localeCompare(b.path);
  });

  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const options = sortedPackages.map((pkg) => {
    const shortPath = pkg.path.split("/").slice(1).join("/") || pkg.path;
    const entry = history[pkg.name];
    const isRecent = entry && entry.lastBuilt > cutoff;
    const hint = isRecent
      ? `${pkg.name} · ${timeAgo(entry!.lastBuilt)}`
      : pkg.name;
    return {
      value: pkg.name,
      label: shortPath,
      hint,
    };
  });

  return filterableMultiselect({
    message: "Select packages to build",
    options,
  });
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function buildSelect(args: string[], ctx: CommandContext): Promise<void> {
  const force = args.includes("--force");

  const { repoRoot: root, dataDir } = ctx.identity!;
  const selectedPackages = await selectPackages(root, dataDir);

  if (!selectedPackages || selectedPackages.length === 0) {
    console.log(`\n  ${yellow}nothing selected, exiting${reset}\n`);
    process.exit(0);
  }

  const filters = selectedPackages.map((p) => `--filter=${p}`).join(" ");
  const forceFlag = force ? " --force" : "";
  const cmd = `pnpm turbo run build ${filters}${forceFlag}`;

  console.log("");
  console.log(
    `  ${bold}${cyan}building ${selectedPackages.length} package${selectedPackages.length !== 1 ? "s" : ""}${force ? " (force)" : ""}...${reset}`,
  );
  console.log(`  ${dim}${cmd}${reset}`);
  console.log("");

  try {
    execSync(cmd, {
      cwd: root,
      stdio: "inherit",
    });
    saveHistory(dataDir, selectedPackages);
  } catch {
    process.exit(1);
  }
}
