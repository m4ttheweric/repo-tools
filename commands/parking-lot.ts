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
import { describeRepoBindings, park } from "../lib/daemon/parking-lot.ts";
import { daemonQuery } from "../lib/daemon-client.ts";
import { getRepoIdentity } from "../lib/repo.ts";
import { getCurrentBranch } from "../lib/git-ops.ts";

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

  const allRepoNames = Object.keys(repos);
  if (allRepoNames.length === 0) {
    console.log(`  ${dim}no repos tracked — register one with rt from inside a repo${reset}\n`);
    return;
  }

  // Scope to the current repo when invoked from inside one. Outside a repo,
  // fall through and show every tracked repo.
  const identity = getRepoIdentity();
  const repoNames = identity && repos[identity.repoName] ? [identity.repoName] : allRepoNames;

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

export async function parkThisCommand(): Promise<void> {
  const identity = getRepoIdentity();
  if (!identity) {
    console.log(`  ${red}✗${reset} not in a git repo\n`);
    process.exit(1);
  }

  const repos = loadRepos();
  const repoPath = repos[identity.repoName];
  if (!repoPath) {
    console.log(`  ${red}✗${reset} repo "${identity.repoName}" not registered in ~/.rt/repos.json\n`);
    process.exit(1);
  }

  const worktreePath = identity.repoRoot;
  const branch = getCurrentBranch(worktreePath);
  if (!branch) {
    console.log(`  ${red}✗${reset} worktree is detached — check out a branch first\n`);
    process.exit(1);
  }

  const bindings = describeRepoBindings(identity.repoName, repoPath);
  const binding = bindings.find(b => b.path === worktreePath);
  if (!binding || !binding.index) {
    console.log(`  ${red}✗${reset} no parking-lot index for ${worktreePath}\n`);
    process.exit(1);
  }

  const parkBranch = `parking-lot/${binding.index}`;
  if (branch === parkBranch) {
    console.log(`  ${dim}already on ${parkBranch} — nothing to park${reset}\n`);
    return;
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"];
  let fi = 0;
  const renderFrame = () => {
    process.stderr.write(`\r  ${cyan}${frames[fi++ % frames.length]}${reset} ${dim}parking ${branch} → ${parkBranch}…${reset}`);
  };
  renderFrame();
  const spinner = setInterval(renderFrame, 80);

  // Route through the daemon so the work runs off this event loop and the
  // spinner can actually animate while we await. If the daemon isn't
  // reachable, fall back to in-process park (spinner will freeze, but the
  // park still happens).
  let result: { ok: boolean; action: string; detail?: string };
  let logs: string[] = [];

  const response = await daemonQuery(
    "parking-lot:park-this",
    { worktreePath, repoPath, branch, index: binding.index },
    60_000,
  );

  if (response?.ok && response.data?.result) {
    result = response.data.result as typeof result;
    logs = (response.data.lines as string[]) ?? [];
  } else {
    // Daemon unreachable, doesn't recognize the command (old build), or errored
    // → in-process fallback. Spinner will freeze, but the park still happens.
    result = park(worktreePath, repoPath, branch, binding.index, msg => logs.push(msg));
  }

  clearInterval(spinner);
  process.stderr.write(`\r\x1b[K`);

  if (result.ok) {
    const defaultRef = result.detail?.match(/@ (\S+)/)?.[1] ?? "origin/master";
    console.log(`  ${green}✓${reset} parked ${bold}${branch}${reset} ${dim}→${reset} ${cyan}${parkBranch}${reset} ${dim}@ ${defaultRef}${reset}\n`);
  } else {
    for (const line of logs) console.log(`  ${dim}${line}${reset}`);
    console.log(`  ${red}✗${reset} ${result.action}${result.detail ? ` — ${result.detail}` : ""}\n`);
    process.exit(1);
  }
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
