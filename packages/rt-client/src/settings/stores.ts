/**
 * Reading the four settings store files (RT-47).
 *
 * `readStore` is the shared "raw JSONC → {global, repos}" step every store
 * (user/team/machine) goes through before the resolver layers them by scope.
 * It uses jsonc-parser (`parse`) rather than lib/jsonc.ts's stripJsonc: this
 * is the one place in rt that also needs to WRITE these files back with
 * comments/formatting intact (via jsonc-parser's `modify`/`applyEdits`, added
 * alongside `setSetting` in resolve.ts), and both directions should go
 * through the same library. stripJsonc keeps its existing callers.
 *
 * A store file is honest-degrade, not throw-on-read: absent, empty, or
 * malformed all resolve to an empty store rather than crashing a caller that
 * just wants "whatever settings exist" (teammates run version-skewed
 * binaries; a store file with content this rt can't parse must not brick
 * every settings read).
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "fs";
import { parse, type ParseError } from "jsonc-parser";
import { join } from "path";
import { teamsDir, teamSettingsPath } from "./paths.ts";

export interface StoreFile {
  /** Top-level keys other than "repos" — the global scope for this store. */
  global: Record<string, unknown>;
  /** The "repos" object, keyed by repo identity. Empty if absent. */
  repos: Record<string, Record<string, unknown>>;
  /** The path this store was read from (echoed back for provenance). */
  file: string;
  /** False only when the file does not exist at all. */
  exists: boolean;
}

const EMPTY_STORE = (file: string, exists: boolean): StoreFile => ({
  global: {},
  repos: {},
  file,
  exists,
});

/**
 * Reads and parses one settings store file. Never throws:
 *  - missing file → `{ exists: false }`, empty maps.
 *  - present but malformed (parse errors, or a root that isn't a JSON
 *    object) → `{ exists: true }`, empty maps, one console.warn.
 *  - present and well-formed → `{ exists: true }`, split into
 *    `global`/`repos`.
 */
export function readStore(file: string): StoreFile {
  if (!existsSync(file)) return EMPTY_STORE(file, false);

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    console.warn(`rt: failed to read settings store ${file}, ignoring: ${(err as Error).message}`);
    return EMPTY_STORE(file, true);
  }

  if (raw.trim() === "") return EMPTY_STORE(file, true);

  const errors: ParseError[] = [];
  const root = parse(raw, errors, { allowTrailingComma: true });

  if (errors.length > 0 || root === undefined || typeof root !== "object" || Array.isArray(root)) {
    console.warn(`rt: malformed settings store ${file}, ignoring (treating as empty)`);
    return EMPTY_STORE(file, true);
  }

  const { repos, ...global } = root as Record<string, unknown>;
  const reposIsValid = repos !== undefined && typeof repos === "object" && repos !== null && !Array.isArray(repos);

  if (repos !== undefined && !reposIsValid) {
    console.warn(`rt: malformed "repos" section in settings store ${file}, ignoring repo sections (global keys still apply)`);
  }

  const reposValid = reposIsValid ? (repos as Record<string, Record<string, unknown>>) : {};

  return { global, repos: reposValid, file, exists: true };
}

/**
 * Names of every team that has a local settings store — i.e. subdirectories
 * of teamsDir() that contain mattstack/settings.team.jsonc. A team dir without a
 * settings file (a clone mid-setup, or an unrelated directory) is not yet a
 * team as far as the resolver is concerned.
 *
 * Honest-degrade like readStore, and for a sharper reason: this scan is on the
 * path of EVERY settings resolution, so one bad directory entry must never
 * brick `rt settings` or any reader behind it. A team clone that was symlinked
 * in and later moved leaves a dangling symlink here, and the follow-the-link
 * stat that keeps symlinked clones working throws ENOENT on exactly that — so
 * the scan is guarded twice: around the readdir (an unreadable teams dir means
 * no teams), and around EACH entry (a dangling link, an EACCES, or a stat that
 * loses a race with a concurrent move skips that entry and leaves the healthy
 * teams intact).
 */
export function listTeams(): string[] {
  const dir = teamsDir();
  if (!existsSync(dir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`rt: failed to list teams in ${dir}, treating as no teams: ${(err as Error).message}`);
    return [];
  }

  const teams: string[] = [];
  for (const entry of entries) {
    try {
      // isDirectory() is false for a symlink, but a symlinked team clone is a
      // real team — those resolve through stat, which is also what throws on a
      // dangling link, hence the per-entry try.
      const isDir =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && statSync(join(dir, entry.name)).isDirectory());
      if (!isDir) continue;
      if (existsSync(teamSettingsPath(entry.name))) teams.push(entry.name);
    } catch (err) {
      console.warn(
        `rt: skipping unreadable teams entry ${join(dir, entry.name)}: ${(err as Error).message}`,
      );
    }
  }
  return teams;
}
