/**
 * Per-repo history of `rt run` invocations — thin wrapper over
 * lib/state/run-history-store.ts's `run_history` table.
 *
 * Consumed by `rt run again` (the picker of recents) and the `rt`
 * no-arg menu's Recent section.
 *
 * Every `repoName`/`repo` parameter below is actually the serialized repo
 * identity — the table's `repo` column key, matching `repoDataDir`'s own
 * identity-keyed layout — not a display name.
 */

import { existsSync, readFileSync, renameSync } from "fs";
import { legacyRepoFile } from "./legacy-repo-data.ts";
import {
  appendRunHistoryEntry,
  hasRunHistory,
  listRunHistory,
  type RunHistoryEntry,
} from "./state/index.ts";
import { rekeyTableColumn, type RekeyReport } from "./state/identity-migrate.ts";

export type { RunHistoryEntry } from "./state/index.ts";

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
function legacyHistoryPath(repoName: string): string {
  return legacyRepoFile(repoName, "run-history.jsonl");
}

/**
 * One-shot: re-key legacy NAME-keyed `run_history` rows onto serialized
 * identities. Exported for the daemon-boot migration runner; this module
 * does not wire the boot call.
 */
export function rekeyRunHistoryTable(): Promise<RekeyReport> {
  return rekeyTableColumn("run_history", "repo");
}

/**
 * JSONL, not a single JSON document, so there is no one `JSON.parse` whose
 * failure means "corrupt file" — a malformed LINE is skipped exactly as the
 * pre-migration reader tolerated it. The file only counts as corrupt (warn,
 * leave in place) when it has content but NONE of it parsed, or when the
 * read itself fails.
 *
 * Renames only after CONFIRMING the inserts landed (`hasRunHistory`) —
 * `appendRunHistoryEntry` writes through `persistOrWarn`, which warns and
 * swallows `SQLITE_BUSY` rather than throwing, so entries.length > 0 does
 * NOT mean the rows are actually in the table. A file that had genuinely no
 * entries to begin with (`lines.length === 0`) has nothing to lose either
 * way and is always safe to rename.
 *
 * Called from BOTH read (`readRunHistory`) and write (`appendRunHistory`) —
 * a bare append reached without a prior read must still absorb any legacy
 * history first, or it would strand the file the moment the append makes
 * the table non-empty for this repo.
 */
function importLegacyHistoryFile(repoName: string): void {
  if (hasRunHistory(repoName)) return;

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

  if (entries.length > 0 && !hasRunHistory(repoName)) {
    console.warn(`rt: imported legacy run history ${path} but the write did not land (db busy?) — leaving it in place to retry on the next read`);
    return;
  }

  try {
    renameSync(path, `${path}.migrated`);
  } catch (err) {
    console.warn(`rt: imported legacy run history ${path} but could not rename it to .migrated: ${(err as Error).message}`);
  }
}

/** Newest-first. */
export function readRunHistory(repoName: string, limit?: number): RunHistoryEntry[] {
  importLegacyHistoryFile(repoName);
  return limit === undefined ? listRunHistory(repoName) : listRunHistory(repoName, limit);
}

/**
 * Best-effort — a dropped write must never break the user's actual command
 * invocation. Call sites (commands/run.ts) run this AFTER the user's command
 * has already completed, so ANY failure here (not just SQLITE_BUSY, which
 * appendRunHistoryEntry's persistOrWarn already swallows) must be caught,
 * not rethrown.
 *
 * Imports any legacy history FIRST, never just renames it away: a single-
 * script package's `rt run` (commands/run.ts's early-return path) reaches
 * this function without ever calling `readRunHistory` first, so this is the
 * only chance to fold pre-upgrade history in before this call's own append
 * makes the table non-empty and the read-side import gate stops firing.
 */
export function appendRunHistory(repoName: string, entry: RunHistoryEntry): void {
  try {
    importLegacyHistoryFile(repoName);
    appendRunHistoryEntry(repoName, entry);
  } catch (err) {
    console.warn(`rt: failed to record run history for ${repoName}: ${(err as Error).message}`);
  }
}
