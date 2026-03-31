/**
 * rt branch clean — Interactive stale branch cleanup.
 *
 * Sorts branches by last commit date, highlights merged/closed MRs,
 * and lets you bulk-delete with safety checks.
 *
 * Safety:
 *  - Can't delete the current branch
 *  - Can't delete default branches (main, master, develop, etc.)
 *  - Warns before deleting branches with open MRs
 *  - Dry-run by default; --force to actually delete
 */

import { execSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset, blue } from "../lib/tui.ts";
import {
  listAllBranches,
  getWorktreeBranches,
  getCurrentBranch,
  type BranchInfo,
} from "../lib/git-ops.ts";
import { daemonQuery } from "../lib/daemon-client.ts";
import type { MRDashboardProps } from "../lib/enrich.ts";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BRANCHES = new Set([
  "main", "master", "develop", "development", "staging", "production", "dev",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(epochSec: number): string {
  const ms = Date.now() - epochSec * 1000;
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function deleteBranch(cwd: string, branch: string, force: boolean): boolean {
  const flag = force ? "-D" : "-d";
  try {
    execSync(`git branch ${flag} "${branch}"`, { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export async function cleanBranches(args: string[], ctx: CommandContext): Promise<void> {
  const cwd = process.cwd();
  const forceDelete = args.includes("--force") || args.includes("-f");
  const dryRun = args.includes("--dry-run") || args.includes("-n");

  const currentBranch = getCurrentBranch(cwd);
  const worktreeBranches = getWorktreeBranches(cwd);
  const allBranches = listAllBranches(cwd);

  // Get enrichment data from daemon cache
  let enrichment: Record<string, { mr: MRDashboardProps | null }> = {};
  const daemonResult = await daemonQuery("cache:read");
  if (daemonResult?.ok && daemonResult.data) {
    enrichment = daemonResult.data;
  }

  // Filter to cleanable local branches (not current, not default, not in worktree)
  const candidates = allBranches.filter((b) => {
    if (!b.isLocal) return false;
    if (b.name === currentBranch) return false;
    if (DEFAULT_BRANCHES.has(b.name)) return false;
    if (worktreeBranches.has(b.name)) return false;
    return true;
  });

  if (candidates.length === 0) {
    console.log(`\n  ${dim}no cleanable branches${reset}\n`);
    return;
  }

  // Sort by commit date: oldest first
  candidates.sort((a, b) => a.commitEpoch - b.commitEpoch);

  // Build fzf options with staleness + MR status hints
  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const options = candidates.map((b) => {
    const age = timeAgo(b.commitEpoch);
    const mr = enrichment[b.name]?.mr;

    let statusHint = "";
    if (mr) {
      if (mr.state === "merged") statusHint = `${blue}merged${reset}`;
      else if (mr.state === "closed") statusHint = `${dim}closed${reset}`;
      else if (mr.state === "opened") statusHint = `${green}open MR${reset}`;
    }

    const hint = [age, statusHint].filter(Boolean).join("  ");

    return {
      value: b.name,
      label: b.name,
      hint,
    };
  });

  // Pre-select merged/closed branches (safe to delete)
  const safeToDelete = candidates
    .filter((b) => {
      const mr = enrichment[b.name]?.mr;
      return mr && (mr.state === "merged" || mr.state === "closed");
    })
    .map((b) => b.name);

  const selected = await filterableMultiselect({
    message: `Clean branches${dryRun ? " (dry run)" : ""}`,
    options,
    initialValues: safeToDelete.length > 0 ? safeToDelete : undefined,
  });

  if (!selected || selected.length === 0) {
    console.log(`\n  ${dim}nothing selected${reset}\n`);
    return;
  }

  // Check for open MRs in the selection
  const withOpenMR = selected.filter((name) => {
    const mr = enrichment[name]?.mr;
    return mr && mr.state === "opened";
  });

  if (withOpenMR.length > 0 && !forceDelete) {
    const { confirm } = await import("../lib/rt-render.tsx");
    console.log("");
    for (const name of withOpenMR) {
      console.log(`  ${yellow}⚠${reset} ${name} has an open MR`);
    }
    const ok = await confirm({
      message: `Delete ${withOpenMR.length} branch${withOpenMR.length > 1 ? "es" : ""} with open MRs?`,
      initialValue: false,
    });
    if (!ok) {
      console.log(`\n  ${dim}cancelled${reset}\n`);
      return;
    }
  }

  // Delete
  console.log("");
  let deleted = 0;
  let failed = 0;

  for (const name of selected) {
    if (dryRun) {
      console.log(`  ${dim}would delete${reset} ${name}`);
      deleted++;
      continue;
    }

    const success = deleteBranch(cwd, name, forceDelete);
    if (success) {
      console.log(`  ${green}✓${reset} ${dim}deleted${reset} ${name}`);
      deleted++;
    } else {
      // Try force delete
      if (!forceDelete) {
        const forceSuccess = deleteBranch(cwd, name, true);
        if (forceSuccess) {
          console.log(`  ${yellow}✓${reset} ${dim}force-deleted${reset} ${name}`);
          deleted++;
          continue;
        }
      }
      console.log(`  ${red}✗${reset} ${dim}failed${reset} ${name}`);
      failed++;
    }
  }

  console.log("");
  if (dryRun) {
    console.log(`  ${dim}dry run: ${deleted} branch${deleted !== 1 ? "es" : ""} would be deleted${reset}`);
    console.log(`  ${dim}run with --force to delete${reset}`);
  } else {
    console.log(`  ${green}✓${reset} ${deleted} deleted${failed > 0 ? `  ${red}${failed} failed${reset}` : ""}`);
  }
  console.log("");
}
