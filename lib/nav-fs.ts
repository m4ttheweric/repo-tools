/**
 * Filesystem listing + preview helpers for rt nav.
 *
 * Pure helpers live here (not in commands/nav.ts) so `bun test lib`
 * covers them. commands/nav.ts owns the interactive loop.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";

export interface DirListing {
  folders: string[];
  files: string[];
}

const cmp = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/** List one directory level. Dotfiles are excluded unless showHidden. */
export function listEntries(dir: string, showHidden: boolean): DirListing {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { folders: [], files: [] };
  }
  const folders: string[] = [];
  const files: string[] = [];
  for (const name of entries) {
    if (!showHidden && name.startsWith(".")) continue;
    let isDir: boolean;
    try {
      isDir = statSync(join(dir, name)).isDirectory();
    } catch {
      continue; // broken symlink etc. — skip (matches prior nav behavior)
    }
    (isDir ? folders : files).push(name);
  }
  folders.sort(cmp);
  files.sort(cmp);
  return { folders, files };
}
