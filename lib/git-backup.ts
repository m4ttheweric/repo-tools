/**
 * rt git backup — Ephemeral backup branches for destructive git operations.
 *
 * Every rebase/reset creates a backup branch before modifying history.
 * Naming convention: rt-backup/<operation>/<branch>/<timestamp>
 *
 * Used by:
 *   - rt git rebase (auto-backup before rebase)
 *   - rt git reset  (auto-backup before reset)
 *   - rt git backup (manual backup)
 *   - rt git restore (interactive restore from any backup)
 */

import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BackupBranch {
  /** Full ref name (e.g. "rt-backup/rebase/cv-1403/2026-04-09T00-27-40") */
  ref: string;
  /** Operation that created the backup (rebase, reset, manual) */
  operation: string;
  /** Original branch name */
  originalBranch: string;
  /** When the backup was created */
  timestamp: string;
  /** Commit SHA the backup points to */
  sha: string;
}

const BACKUP_PREFIX = "rt-backup/";

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a backup branch pointing at the current HEAD.
 *
 * @param operation - What triggered this (e.g. "rebase", "reset", "manual")
 * @param cwd - Repo working directory
 * @returns The full backup branch name
 */
export function createBackup(operation: string, cwd: string): string {
  const branch = getCurrentBranchOrThrow(cwd);
  const ts = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  const backupRef = `${BACKUP_PREFIX}${operation}/${branch}/${ts}`;

  execSync(`git branch "${backupRef}"`, { cwd, stdio: "pipe" });
  return backupRef;
}

// ─── List ────────────────────────────────────────────────────────────────────

/**
 * List all rt-backup/* branches with parsed metadata, newest first.
 */
export function listBackups(cwd: string): BackupBranch[] {
  let stdout: string;
  try {
    stdout = execSync(
      `git branch --list "${BACKUP_PREFIX}*" --format="%(refname:short)\t%(objectname:short)" --sort=-committerdate`,
      { cwd, encoding: "utf8", stdio: "pipe" },
    );
  } catch {
    return [];
  }

  const results: BackupBranch[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ref, sha] = trimmed.split("\t");
    if (!ref || !sha) continue;

    const parsed = parseBackupRef(ref);
    if (parsed) {
      results.push({ ref, sha, ...parsed });
    }
  }

  return results;
}

/**
 * List backups for a specific branch.
 */
export function listBackupsForBranch(cwd: string, branch: string): BackupBranch[] {
  return listBackups(cwd).filter((b) => b.originalBranch === branch);
}

// ─── Restore ─────────────────────────────────────────────────────────────────

/**
 * Restore the current branch to a backup's commit.
 * Performs a `git reset --hard <backup-ref>`.
 */
export function restoreFromBackup(backupRef: string, cwd: string): void {
  execSync(`git reset --hard "${backupRef}"`, { cwd, stdio: "pipe" });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Delete a specific backup branch.
 */
export function deleteBackup(backupRef: string, cwd: string): void {
  execSync(`git branch -D "${backupRef}"`, { cwd, stdio: "pipe" });
}

/**
 * Delete all backup branches for a specific original branch.
 */
export function deleteBackupsForBranch(cwd: string, branch: string): number {
  const backups = listBackupsForBranch(cwd, branch);
  for (const b of backups) {
    deleteBackup(b.ref, cwd);
  }
  return backups.length;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentBranchOrThrow(cwd: string): string {
  try {
    const branch = execSync("git symbolic-ref --quiet --short HEAD", {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    if (!branch) throw new Error("detached HEAD");
    return branch;
  } catch {
    throw new Error("cannot create backup: not on a branch (detached HEAD)");
  }
}

/**
 * Parse a backup ref like "rt-backup/rebase/cv-1403/2026-04-09T00-27-40"
 * into its components.
 */
function parseBackupRef(
  ref: string,
): { operation: string; originalBranch: string; timestamp: string } | null {
  if (!ref.startsWith(BACKUP_PREFIX)) return null;

  const rest = ref.slice(BACKUP_PREFIX.length);
  // Format: <operation>/<branch>/<timestamp>
  // Branch can contain slashes, so we take the first segment as operation
  // and the last segment as timestamp (ISO-like with dashes).
  const firstSlash = rest.indexOf("/");
  if (firstSlash === -1) return null;

  const operation = rest.slice(0, firstSlash);
  const remainder = rest.slice(firstSlash + 1);

  // The timestamp is the last segment — ISO-like: 2026-04-09T00-27-40
  const lastSlash = remainder.lastIndexOf("/");
  if (lastSlash === -1) return null;

  const originalBranch = remainder.slice(0, lastSlash);
  const timestamp = remainder.slice(lastSlash + 1);

  if (!operation || !originalBranch || !timestamp) return null;
  return { operation, originalBranch, timestamp };
}
