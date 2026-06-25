/**
 * Per-repo script variations for rt run.
 *
 * Storage: <dataDir>/variations.json — a single JSON object keyed by
 * `repoRelativePath:scriptName`, each value an array of {name, command}.
 *
 * Keys use repo-relative paths so variations are shared across worktrees
 * (worktree roots differ, but the relative package path within the repo
 * is stable).
 *
 * Best-effort I/O — silently swallows errors so a broken/missing file
 * never blocks the user's actual command invocation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, relative } from "path";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Variation {
  /** User-facing label shown in the variations sub-picker. */
  name: string;
  /** Full shell command string to execute. */
  command: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

function variationsPath(dataDir: string): string {
  return join(dataDir, "variations.json");
}

// ─── Keys ───────────────────────────────────────────────────────────────────

/**
 * Build a worktree-independent key from the repo root and absolute package
 * path.  Uses a repo-relative path so that the same package accessed from
 * different worktrees maps to the same key.
 */
export function variationKey(repoRoot: string, packagePath: string, script: string): string {
  const rel = relative(repoRoot, packagePath) || ".";
  return `${rel}:${script}`;
}

// ─── Read ───────────────────────────────────────────────────────────────────

export function loadVariations(
  dataDir: string,
): Record<string, Variation[]> {
  const path = variationsPath(dataDir);
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, Variation[]>;
  } catch {
    return {};
  }
}

// ─── Write ──────────────────────────────────────────────────────────────────

export function saveVariation(
  dataDir: string,
  repoRoot: string,
  packagePath: string,
  script: string,
  variation: Variation,
): void {
  const path = variationsPath(dataDir);
  const key = variationKey(repoRoot, packagePath, script);

  const all = loadVariations(dataDir);
  const list = all[key] ?? [];
  all[key] = [...list, variation];

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
  } catch {
    // best effort — don't break the user's command over a write error
  }
}
