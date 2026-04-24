/**
 * Per-repo history of `rt run` invocations.
 *
 * Storage: <dataDir>/run-history.jsonl — append-only JSONL.
 * Bounded: compacted to the most-recent MAX_ENTRIES when the file grows
 * past COMPACT_THRESHOLD.
 *
 * Consumed by `rt run again` (the fzf picker of recents) and the `rt`
 * no-arg menu's Recent section.
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RunHistoryEntry {
  /** ISO timestamp of the invocation. */
  ts: string;
  /** Resolved command string, e.g. "pnpm run test:user". */
  cmd: string;
  /** Absolute directory the command ran in. */
  cwd: string;
  /** Worktree root path at invocation time. */
  worktree: string;
  /** Branch checked out at invocation time. */
  branch: string;
  /** Package label (e.g. "api", "web", ".", "root"). */
  pkg: string;
  /** Script name (e.g. "test:user", "dev"). */
  script: string;
  /** Exit code. null while running or if not captured. */
  exit: number | null;
}

// ─── Tuning ──────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 200;
const COMPACT_THRESHOLD = 300;

// ─── Paths ───────────────────────────────────────────────────────────────────

function historyPath(dataDir: string): string {
  return join(dataDir, "run-history.jsonl");
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Read entries in newest-first order. Malformed lines are skipped silently.
 */
export function readRunHistory(dataDir: string, limit = MAX_ENTRIES): RunHistoryEntry[] {
  const path = historyPath(dataDir);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.length > 0);
  const entries: RunHistoryEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }

  return entries.reverse().slice(0, limit);
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Append an entry. Compacts the file when it grows past COMPACT_THRESHOLD.
 * Best-effort — silently swallows write errors to avoid breaking the user's
 * actual command invocation.
 */
export function appendRunHistory(dataDir: string, entry: RunHistoryEntry): void {
  const path = historyPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    return;
  }

  // Lazy compaction: rewrite with the tail when we've drifted past the threshold.
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length > COMPACT_THRESHOLD) {
      writeFileSync(path, lines.slice(-MAX_ENTRIES).join("\n") + "\n");
    }
  } catch {
    // best effort
  }
}
