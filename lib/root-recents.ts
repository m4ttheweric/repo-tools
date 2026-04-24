/**
 * Root picker "Recent" section.
 *
 * When `rt` is invoked with no args from inside a known repo, the root
 * picker prepends a handful of recently-run scripts so common loops are
 * one keystroke away. Entries come from the same per-repo run history
 * that `rt run again` reads.
 *
 * The main `rt run` picker is deliberately left alone — this is only for
 * the top-level menu surface, never for the in-command hot path.
 */

import { existsSync } from "fs";
import { basename } from "path";
import { getRepoIdentity } from "./repo.ts";
import { getKnownRepos } from "./repo-index.ts";
import { readRunHistory, type RunHistoryEntry } from "./run-history.ts";

/** Sentinel prefix used to distinguish recent entries from command names. */
export const ROOT_RECENT_PREFIX = "__recent__:";

const MAX_ROOT_RECENTS = 5;

export interface RootRecentOption {
  value: string; // `${ROOT_RECENT_PREFIX}${index}`
  label: string;
  hint: string;
}

/**
 * Load recent-run options for the root picker, plus the underlying entries
 * indexed by the option value for downstream execution.
 *
 * Merges history across every known repo so the root menu shows a flat list
 * regardless of where `rt` was invoked from. Entries are sorted newest first.
 */
export function loadRootRecents(): {
  options: RootRecentOption[];
  byValue: Map<string, RunHistoryEntry>;
} {
  const all: RunHistoryEntry[] = [];
  for (const repo of getKnownRepos()) {
    for (const entry of readRunHistory(repo.dataDir)) {
      all.push(entry);
    }
  }
  all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  // Dedupe by (cmd, cwd) — keep newest. Same pattern as rt run again.
  const seen = new Set<string>();
  const deduped: RunHistoryEntry[] = [];
  for (const entry of all) {
    const key = `${entry.cmd}\x00${entry.cwd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  const entries = deduped.slice(0, MAX_ROOT_RECENTS);
  if (entries.length === 0) return { options: [], byValue: new Map() };

  // Keep getRepoIdentity call so repo registration still triggers the usual
  // side-effects for users who invoke rt no-arg from inside a repo.
  getRepoIdentity();

  const byValue = new Map<string, RunHistoryEntry>();
  const options: RootRecentOption[] = entries.map((entry, idx) => {
    const value = `${ROOT_RECENT_PREFIX}${idx}`;
    byValue.set(value, entry);
    const worktreeName = entry.worktree ? basename(entry.worktree) : "";
    const sub = entry.pkg && entry.pkg !== "." && entry.pkg !== "root" ? ` · ${entry.pkg}` : "";
    return {
      value,
      label: entry.cmd,
      hint: `recent · ${formatAge(entry.ts)} · ${worktreeName}${sub}`,
    };
  });

  return { options, byValue };
}

/**
 * Execute a recent-run entry directly: spawn the same command in the same
 * cwd it originally ran in, and re-log it so future invocations see it as
 * freshly used.
 */
export async function executeRecentEntry(entry: RunHistoryEntry): Promise<never> {
  if (!existsSync(entry.cwd)) {
    process.stderr.write(`\n  skipping — directory no longer exists: ${entry.cwd}\n\n`);
    process.exit(1);
  }

  process.stderr.write(`\nRunning: ${entry.cmd}\n`);
  process.stderr.write(`  in: ${entry.cwd}\n\n`);

  const proc = Bun.spawn(["bash", "-c", entry.cmd], {
    cwd: entry.cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;

  const identity = getRepoIdentity();
  if (identity) {
    const { appendRunHistory } = await import("./run-history.ts");
    appendRunHistory(identity.dataDir, {
      ts: new Date().toISOString(),
      cmd: entry.cmd,
      cwd: entry.cwd,
      worktree: entry.worktree,
      branch: entry.branch,
      pkg: entry.pkg,
      script: entry.script,
      exit: typeof exitCode === "number" ? exitCode : null,
    });
  }

  process.exit(exitCode ?? 0);
}

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
