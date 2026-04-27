#!/usr/bin/env bun

/**
 * rt parking-lot — inspect and control the daemon's auto-park feature.
 *
 * The daemon watches tracked worktree branches for MRs that transition to
 * `merged` / `closed` and auto-parks the worktree onto `parking-lot/<N>`
 * (stash → fast-forward from origin/master). This command is the user-facing
 * lever: toggle the feature, view the current bindings, or fire a manual scan.
 *
 * Usage:
 *   rt parking-lot           → same as `status`
 *   rt parking-lot status    → show enabled flag + worktree bindings
 *   rt parking-lot enable    → turn auto-park on
 *   rt parking-lot disable   → turn auto-park off
 *   rt parking-lot scan      → run the park check once against live cache
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { bold, cyan, dim, green, reset, yellow, red } from "../lib/tui.ts";
import { RT_DIR } from "../lib/daemon-config.ts";
import {
  loadParkingLotConfig,
  saveParkingLotConfig,
  PARKING_LOT_CONFIG_PATH,
} from "../lib/parking-lot-config.ts";
import { describeRepoBindings } from "../lib/daemon/parking-lot.ts";
import { daemonQuery } from "../lib/daemon-client.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadRepos(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(RT_DIR, "repos.json"), "utf8"));
  } catch {
    return {};
  }
}

function dot(enabled: boolean): string {
  return enabled ? `${green}●${reset}` : `${dim}○${reset}`;
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function statusCommand(): Promise<void> {
  const config = loadParkingLotConfig();
  const repos  = loadRepos();

  console.log(`\n  ${bold}${cyan}rt park${reset}\n`);
  console.log(`  ${dot(config.enabled)} auto-park ${config.enabled ? `${green}enabled${reset}` : `${dim}disabled${reset}`}`);
  console.log(`    ${dim}config: ${PARKING_LOT_CONFIG_PATH}${reset}`);
  console.log("");

  const repoNames = Object.keys(repos);
  if (repoNames.length === 0) {
    console.log(`  ${dim}no repos tracked — register one with rt from inside a repo${reset}\n`);
    return;
  }

  for (const repoName of repoNames) {
    const repoPath = repos[repoName]!;
    console.log(`  ${bold}${repoName}${reset} ${dim}${repoPath}${reset}`);

    if (!existsSync(repoPath)) {
      console.log(`    ${yellow}⚠${reset} path missing on disk\n`);
      continue;
    }

    const bindings = describeRepoBindings(repoName, repoPath);
    if (bindings.length === 0) {
      console.log(`    ${dim}no worktrees${reset}\n`);
      continue;
    }

    const widest    = Math.max(...bindings.map(b => String(b.index).length));
    const repoDir   = repoPath.replace(/\/[^/]+\/?$/, "");
    const wtNames   = bindings.map(b => b.path.startsWith(repoDir + "/") ? b.path.slice(repoDir.length + 1) : b.path);
    const widestWt  = Math.max(...wtNames.map(s => s.length));
    for (let i = 0; i < bindings.length; i++) {
      const b      = bindings[i]!;
      const idx    = String(b.index).padStart(widest);
      const wt     = wtNames[i]!.padEnd(widestWt);
      const slot   = `parking-lot/${b.index}`;
      const status = b.branch === null     ? `${dim}(detached)${reset}`
                   : b.branch === slot     ? `${green}parked${reset}`
                   :                         b.branch;
      console.log(`    ${cyan}park/${idx}${reset}  ${dim}${wt}${reset}  ${status}`);
    }
    console.log("");
  }
}

export async function enableCommand(): Promise<void> {
  const current = loadParkingLotConfig();
  if (current.enabled) {
    console.log(`\n  ${dim}auto-park is already enabled${reset}\n`);
    return;
  }
  saveParkingLotConfig({ enabled: true });
  console.log(`\n  ${green}✓${reset} auto-park enabled\n`);
  console.log(`  ${dim}the daemon will resume parking worktrees on the next cache refresh${reset}\n`);
}

export async function disableCommand(): Promise<void> {
  const current = loadParkingLotConfig();
  if (!current.enabled) {
    console.log(`\n  ${dim}auto-park is already disabled${reset}\n`);
    return;
  }
  saveParkingLotConfig({ enabled: false });
  console.log(`\n  ${green}✓${reset} auto-park disabled\n`);
  console.log(`  ${dim}daemon scans will no-op until you run: rt parking-lot enable${reset}\n`);
}

export async function scanCommand(): Promise<void> {
  console.log(`\n  ${bold}${cyan}rt parking-lot scan${reset}\n`);

  if (!loadParkingLotConfig().enabled) {
    console.log(`  ${yellow}⚠${reset} auto-park is disabled — scan is a no-op`);
    console.log(`  ${dim}run: rt parking-lot enable${reset}\n`);
    return;
  }

  const response = await daemonQuery("parking-lot:scan");
  if (!response) {
    console.log(`  ${red}✗${reset} daemon not reachable`);
    console.log(`  ${dim}run: rt daemon start${reset}\n`);
    return;
  }
  if (!response.ok) {
    console.log(`  ${red}✗${reset} scan failed: ${response.error ?? "unknown error"}\n`);
    return;
  }

  const lines = (response.data?.lines as string[] | undefined) ?? [];
  const parkingLines = lines.filter(l => l.startsWith("parking-lot:"));

  if (parkingLines.length === 0) {
    console.log(`  ${green}✓${reset} scan complete — nothing to park\n`);
    return;
  }

  for (const line of parkingLines) console.log(`  ${line}`);
  console.log("");
}
