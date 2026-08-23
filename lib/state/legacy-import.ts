/**
 * lib/state/legacy-import.ts — shared migrate-on-read mechanics for the
 * per-store legacy JSON files Phase 2 left un-imported (RT-48 fix round).
 *
 * Deliberately NOT built on `LEGACY_IMPORTS` (db.ts): that array drains once,
 * inside the v0->v1 transaction, and is now gated to fire only from
 * user_version 0 (see db.ts's `runMigrations`) — a store whose row doesn't
 * exist yet on a v1/v2 machine would never get a chance to import through
 * it. This helper runs on every READ instead, so a store that has no value
 * for its key imports its legacy file lazily, whenever that read happens to
 * occur.
 *
 * Write-before-rename, always: `apply` must persist the imported value into
 * the store BEFORE this function renames the source file. An interrupted
 * process (crash, kill -9) between those two steps leaves the legacy file in
 * place with the store already holding the imported value — the next read
 * finds a non-empty store and skips import, and the orphaned legacy file is
 * inert. Renaming first would risk the opposite: a file gone with nothing
 * written, on a step that cannot be made atomic with the SQLite write (a
 * `rename(2)` cannot join a `bun:sqlite` transaction).
 *
 * `verifyPersisted` closes a second, subtler gap: every `apply` in this
 * codebase writes through `persistOrWarn` (lib/state/busy.ts), which WARNS
 * AND SWALLOWS `SQLITE_BUSY` rather than throwing — so `apply` returning
 * normally does NOT mean the write landed. Without re-checking, a write that
 * silently no-op'd under contention still gets its only other copy renamed
 * away, permanently. `verifyPersisted` re-reads the store (a cheap point
 * lookup — `hasKvValue`/`hasRunHistory`/equivalent) AFTER `apply` and gates
 * the rename on it actually finding the row; a failed check still returns
 * the freshly-parsed value to THIS caller (it did parse correctly) but skips
 * the rename, so the legacy file survives for a retry on the next read.
 */

import { existsSync, readFileSync, renameSync } from "fs";

export interface LegacyImportResult<T> {
  imported: boolean;
  value?: T;
}

export interface ImportLegacyJsonFileOptions {
  onCorrupt?: (err: unknown) => void;
  /**
   * Re-checked after `apply()` returns, before renaming. Must confirm the
   * write `apply` performed actually reached the store (see module doc) —
   * every current caller has a real persistence step to confirm, so this is
   * required rather than defaulted to "always rename".
   */
  verifyPersisted: () => boolean;
}

function defaultOnCorrupt(legacyPath: string): (err: unknown) => void {
  return (err) => {
    console.warn(`rt: legacy state file ${legacyPath} is corrupt JSON, leaving in place: ${(err as Error).message}`);
  };
}

/**
 * If `legacyPath` exists, parses it as JSON and hands the parsed value to
 * `apply` (which must write it into the store). Renames the file to
 * `<name>.migrated` — the same convention db.ts's own legacy-import seam
 * uses — ONLY when `opts.verifyPersisted()` confirms the write landed;
 * otherwise the file is left in place (a warm retry candidate for the next
 * read) and the freshly-parsed value is still returned to this caller.
 * Corrupt/unparseable JSON: warns via `onCorrupt` and returns
 * `{ imported: false }` WITHOUT calling `apply` or renaming — a file that
 * could not be read is never destroyed, and the same corrupt file is safe to
 * warn about again on the next read.
 */
export function importLegacyJsonFile<T>(
  legacyPath: string,
  apply: (parsed: unknown) => T,
  opts: ImportLegacyJsonFileOptions,
): LegacyImportResult<T> {
  if (!existsSync(legacyPath)) return { imported: false };

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(legacyPath, "utf8"));
  } catch (err) {
    (opts.onCorrupt ?? defaultOnCorrupt(legacyPath))(err);
    return { imported: false };
  }

  const value = apply(json);

  if (!opts.verifyPersisted()) {
    console.warn(`rt: imported legacy state file ${legacyPath} but the write did not land (db busy?) — leaving it in place to retry on the next read`);
    return { imported: true, value };
  }

  try {
    renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch (err) {
    console.warn(`rt: imported legacy state file ${legacyPath} but could not rename it to .migrated: ${(err as Error).message}`);
  }
  return { imported: true, value };
}

/**
 * Best-effort rename-out-of-the-way for a legacy file a fresh write has just
 * superseded — the write-time counterpart to `importLegacyJsonFile`'s
 * read-time rename, kept to the same never-unlink rule. A failure (already
 * gone, permissions) is silently ignored: the store already holds the value
 * that matters either way.
 *
 * Callers whose SAVE path can run without a prior LOAD in the same process
 * (worktree registry, endpoint claims, run history — see their modules) do
 * NOT use this: a blind rename here would strand an unread legacy file
 * exactly like the bug this whole module exists to close. Those instead
 * call their own load function first, which safely imports-and-renames (or
 * leaves in place) through `importLegacyJsonFile` above.
 */
export function renameLegacyOutOfTheWay(legacyPath: string): void {
  try {
    renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch {
    // already gone, never existed, or unrenameable — the store already has the fresh value
  }
}
