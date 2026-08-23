/**
 * Per-repo history of `rt run` invocations — thin wrapper over
 * lib/state/run-history-store.ts's `run_history` table.
 *
 * Consumed by `rt run again` (the fzf picker of recents) and the `rt`
 * no-arg menu's Recent section.
 */

import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { repoDataDir } from "./rt-paths.ts";
import {
  appendRunHistoryEntry,
  hasRunHistory,
  listRunHistory,
  renameLegacyOutOfTheWay,
  type RunHistoryEntry,
} from "./state/index.ts";

export type { RunHistoryEntry } from "./state/index.ts";

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
function legacyHistoryPath(repoName: string): string {
  return join(repoDataDir(repoName), "run-history.jsonl");
}

/**
 * JSONL, not a single JSON document, so there is no one `JSON.parse` whose
 * failure means "corrupt file" — a malformed LINE is skipped exactly as the
 * pre-migration reader tolerated it. The file only counts as corrupt (warn,
 * leave in place) when it has content but NONE of it parsed, or when the
 * read itself fails.
 */
function importLegacyHistoryFile(repoName: string): void {
  const path = legacyHistoryPath(repoName);
  if (!existsSync(path)) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.warn(`rt: legacy run history ${path} could not be read, leaving in place: ${(err as Error).message}`);
    return;
  }

  const lines = raw.split("\n").filter((l) => l.length > 0);
  const entries: RunHistoryEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as RunHistoryEntry);
    } catch {
      // malformed line — skip, matches the pre-migration reader's tolerance
    }
  }
  if (lines.length > 0 && entries.length === 0) {
    console.warn(`rt: legacy run history ${path} had no parseable entries, leaving in place`);
    return;
  }

  // Oldest-first insert order (JSONL append order), so autoincrement id
  // order — and therefore MAX_ENTRIES trimming — matches chronological order.
  for (const entry of entries) appendRunHistoryEntry(repoName, entry);
  try {
    renameSync(path, `${path}.migrated`);
  } catch (err) {
    console.warn(`rt: imported legacy run history ${path} but could not rename it to .migrated: ${(err as Error).message}`);
  }
}

/** Newest-first. */
export function readRunHistory(repoName: string, limit?: number): RunHistoryEntry[] {
  if (!hasRunHistory(repoName)) importLegacyHistoryFile(repoName);
  return limit === undefined ? listRunHistory(repoName) : listRunHistory(repoName, limit);
}

/**
 * Best-effort — a dropped write must never break the user's actual command
 * invocation. Call sites (commands/run.ts) run this AFTER the user's command
 * has already completed, so ANY failure here (not just SQLITE_BUSY, which
 * appendRunHistoryEntry's persistOrWarn already swallows) must be caught,
 * not rethrown.
 */
export function appendRunHistory(repoName: string, entry: RunHistoryEntry): void {
  try {
    appendRunHistoryEntry(repoName, entry);
    renameLegacyOutOfTheWay(legacyHistoryPath(repoName));
  } catch (err) {
    console.warn(`rt: failed to record run history for ${repoName}: ${(err as Error).message}`);
  }
}
