/**
 * Filesystem listing + preview helpers for rt nav.
 *
 * Pure helpers live here (not in commands/nav.ts) so `bun test lib`
 * covers them. commands/nav.ts owns the interactive loop.
 */

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface DirListing {
  folders: string[];
  files: string[];
}

export interface DeepListOpts {
  showHidden: boolean;
  /** Total entry cap (folders + files combined), enforced on both the fd path and the fallback walk. Default 5000. */
  maxResults?: number;
  /** Fallback-walk depth cap. Default 8. (fd path is capped by maxResults only.) */
  maxDepth?: number;
}

export const cmp = (a: string, b: string) =>
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

/**
 * Recursively list everything under dir as relative paths.
 * Uses fd when available (honors .gitignore); otherwise a depth-capped
 * readdir walk that skips .git but does NOT parse .gitignore.
 */
export function deepList(
  dir: string,
  opts: DeepListOpts,
  resolveFd: () => string | null = () => Bun.which("fd"),
): DirListing {
  const maxResults = opts.maxResults ?? 5000;
  const fd = resolveFd();
  if (fd) {
    const common = [
      "--color=never",
      `--max-results=${maxResults}`,
      ...(opts.showHidden ? ["--hidden", "--exclude=.git"] : []),
    ];
    const run = (type: string): string[] => {
      const r = spawnSync(fd, ["--type", type, ...common], {
        cwd: dir,
        encoding: "utf8",
      });
      if (r.status !== 0 || !r.stdout) return [];
      return r.stdout
        .split("\n")
        .filter(Boolean)
        .map((s) => s.replace(/\/$/, ""));
    };
    const folders = run("d").sort(cmp).slice(0, maxResults);
    const files = run("f")
      .sort(cmp)
      .slice(0, Math.max(0, maxResults - folders.length));
    return { folders, files };
  }
  return walkFallback(dir, opts.showHidden, opts.maxDepth ?? 8, maxResults);
}

function walkFallback(
  root: string,
  showHidden: boolean,
  maxDepth: number,
  maxResults: number,
): DirListing {
  const folders: string[] = [];
  const files: string[] = [];
  const full = () => folders.length + files.length >= maxResults;

  const walk = (rel: string, depth: number) => {
    if (depth > maxDepth || full()) return;
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel));
    } catch {
      return;
    }
    entries.sort(cmp);
    for (const name of entries) {
      if (full()) return;
      if (name === ".git") continue;
      if (!showHidden && name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = statSync(join(root, relPath)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        folders.push(relPath);
        walk(relPath, depth + 1);
      } else {
        files.push(relPath);
      }
    }
  };

  walk("", 1);
  return { folders, files };
}
