/**
 * rt git backup — Manual branch backup.
 * rt git restore — Interactive restore from backup.
 *
 * Thin wrappers over lib/git-backup.ts.
 */

import { bold, cyan, dim, green, yellow, red, reset } from "../../lib/tui.ts";
import { getCurrentBranch } from "../../lib/git-ops.ts";
import {
  createBackup,
  listBackups,
  restoreFromBackup,
  deleteBackup,
  type BackupBranch,
} from "../../lib/git-backup.ts";
import type { CommandContext } from "../../lib/command-tree.ts";

// ─── rt git backup ──────────────────────────────────────────────────────────

export async function backupCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const branch = getCurrentBranch(cwd);

  if (!branch) {
    console.error(`\n  ${red}not on a branch (detached HEAD)${reset}\n`);
    process.exit(1);
  }

  const backupRef = createBackup("manual", cwd);
  console.log(`\n  ${green}✓${reset} backed up ${bold}${branch}${reset} → ${dim}${backupRef}${reset}\n`);
}

// ─── rt git restore ─────────────────────────────────────────────────────────

function formatAge(ts: string): string {
  // Timestamp is like "2026-04-09T00-27-40" — convert back to Date
  const normalized = ts.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})$/,
    "$1:$2:$3",
  );
  const date = new Date(normalized + "Z");
  if (isNaN(date.getTime())) return ts;

  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export async function restoreCommand(
  _args: string[],
  ctx: CommandContext,
): Promise<void> {
  const cwd = ctx.identity!.repoRoot;
  const backups = listBackups(cwd);

  if (backups.length === 0) {
    console.log(`\n  ${dim}no backup branches found${reset}\n`);
    return;
  }

  const { filterableSelect, confirm: inkConfirm } = await import(
    "../../lib/rt-render.tsx"
  );

  const selected = await filterableSelect({
    message: "Select a backup to restore",
    options: backups.map((b) => ({
      value: b.ref,
      label: `${b.originalBranch}`,
      hint: `${b.operation} · ${b.sha} · ${formatAge(b.timestamp)}`,
    })),
  });

  if (!selected) {
    console.log(`\n  ${dim}cancelled${reset}\n`);
    return;
  }

  const backup = backups.find((b) => b.ref === selected)!;

  console.log(`\n  restore ${bold}${backup.originalBranch}${reset} to backup ${dim}${backup.sha}${reset}`);
  console.log(`  ${dim}(${backup.operation} from ${formatAge(backup.timestamp)})${reset}`);

  const ok = await inkConfirm({
    message: "Restore? (this does a hard reset)",
    initialValue: true,
  });

  if (!ok) {
    console.log(`\n  ${dim}cancelled${reset}\n`);
    return;
  }

  restoreFromBackup(selected, cwd);
  console.log(`\n  ${green}✓${reset} restored to ${dim}${selected}${reset}\n`);
}
