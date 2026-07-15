#!/usr/bin/env bun

/**
 * rt worktree each — run a command in each worktree of the current repo.
 *
 *   rt worktree each '<cmd>'            interactive multi-select, then run
 *   rt worktree each --all '<cmd>'      run in every worktree (no picker)
 *   rt worktree each --parked '<cmd>'   run only in parked worktrees
 *
 * Sequential, continue-on-failure. Exits non-zero if any target failed.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { bold, dim, green, red, reset } from "../lib/tui.ts";
import { RT_DIR } from "../lib/daemon-config.ts";
import { getRepoIdentity } from "../lib/repo.ts";
import { describeRepoBindings, type WorktreeBinding } from "../lib/daemon/parking-lot.ts";
import {
  parseEachArgs,
  filterTargets,
  relWorktreeName,
  formatSummary,
  hasFailures,
  type EachResult,
} from "../lib/worktree-each.ts";

function loadRepos(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(RT_DIR, "repos.json"), "utf8"));
  } catch {
    return {};
  }
}

function fail(msg: string): never {
  console.log(`  ${red}✗${reset} ${msg}\n`);
  process.exit(1);
}

export async function worktreeEach(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseEachArgs(args);
  if (parsed.error) fail(parsed.error);

  const identity = getRepoIdentity();
  if (!identity) fail("not in a git repo");

  const repos    = loadRepos();
  const repoPath = repos[identity.repoName];
  if (!repoPath) fail(`repo "${identity.repoName}" not registered in ~/.rt/repos.json`);

  const bindings = describeRepoBindings(identity.repoName, repoPath);
  if (bindings.length === 0) {
    console.log(`\n  ${dim}no worktrees in ${identity.repoName}${reset}\n`);
    return;
  }

  let targets: WorktreeBinding[];
  if (parsed.mode === "pick") {
    if (!process.stdin.isTTY) {
      fail("no --all/--parked flag and no TTY for the picker — pass --all or --parked");
    }
    const widest  = Math.max(...bindings.map(b => relWorktreeName(repoPath, b.path).length));
    const options = bindings.map(b => ({
      value: b.path,
      label: relWorktreeName(repoPath, b.path).padEnd(widest),
      hint:  b.branch ?? "(detached)",
    }));
    const { filterableMultiselect } = await import("../lib/rt-render.tsx");
    const selected = await filterableMultiselect({
      message: `Run "${parsed.command}" in which worktrees? (${identity.repoName})`,
      options,
    });
    if (!selected || selected.length === 0) {
      console.log(`\n  ${dim}nothing selected${reset}\n`);
      return;
    }
    const set = new Set(selected);
    targets = bindings.filter(b => set.has(b.path));
  } else {
    targets = filterTargets(bindings, parsed.mode);
    if (targets.length === 0) {
      const what = parsed.mode === "parked" ? "parked worktrees" : "worktrees";
      console.log(`\n  ${dim}no ${what} to run in${reset}\n`);
      return;
    }
  }

  console.log("");
  const results: EachResult[] = [];
  for (const b of targets) {
    const name   = relWorktreeName(repoPath, b.path);
    const branch = b.branch ?? "(detached)";
    console.log(`${bold}── ${name}${reset} ${dim}[${branch}]${reset} ${bold}──${reset}`);

    if (!existsSync(b.path)) {
      console.log(`  ${red}✗${reset} ${dim}path no longer exists${reset}\n`);
      results.push({ name, code: 1, reason: "path gone" });
      continue;
    }

    const res = spawnSync("sh", ["-c", parsed.command], { cwd: b.path, stdio: "inherit" });
    const code = res.status ?? 1;
    console.log(code === 0
      ? `  ${green}✓${reset} ${dim}exit 0${reset}\n`
      : `  ${red}✗${reset} ${dim}exit ${code}${reset}\n`);
    results.push({ name, code });
  }

  const summary = formatSummary(results);
  console.log(`  ${hasFailures(results) ? red : green}${summary}${reset}\n`);
  if (hasFailures(results)) process.exit(1);
}
