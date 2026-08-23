/**
 * Per-repo history of `rt run` invocations — thin wrapper over
 * lib/state/run-history-store.ts's `run_history` table.
 *
 * Consumed by `rt run again` (the fzf picker of recents) and the `rt`
 * no-arg menu's Recent section.
 */

import { unlinkSync } from "fs";
import { join } from "path";
import { repoDataDir } from "./rt-paths.ts";
import { appendRunHistoryEntry, listRunHistory, type RunHistoryEntry } from "./state/index.ts";

export type { RunHistoryEntry } from "./state/index.ts";

/** Retired storage location — kept only so a leftover pre-migration file can be cleaned up. */
function legacyHistoryPath(repoName: string): string {
  return join(repoDataDir(repoName), "run-history.jsonl");
}

function unlinkLegacyHistory(repoName: string): void {
  try {
    unlinkSync(legacyHistoryPath(repoName));
  } catch {
    // already gone, or never existed
  }
}

/** Newest-first. */
export function readRunHistory(repoName: string, limit?: number): RunHistoryEntry[] {
  return limit === undefined ? listRunHistory(repoName) : listRunHistory(repoName, limit);
}

/** Best-effort — a dropped write must never break the user's actual command invocation. */
export function appendRunHistory(repoName: string, entry: RunHistoryEntry): void {
  appendRunHistoryEntry(repoName, entry);
  unlinkLegacyHistory(repoName);
}
