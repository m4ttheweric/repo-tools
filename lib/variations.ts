/**
 * Per-repo script variations for rt run.
 *
 * Resolved through the settings resolver (`rt.variations`, team.repo scope):
 * a single object keyed by `repoRelativePath:scriptName`, each value an array
 * of {name, command}.
 *
 * Keys use repo-relative paths so variations are shared across worktrees
 * (worktree roots differ, but the relative package path within the repo
 * is stable).
 *
 * Best-effort I/O — silently swallows errors so a broken/missing store value
 * never blocks the user's actual command invocation.
 */

import { relative } from "path";
import { getSetting } from "./settings/resolve.ts";
import { setSetting } from "./settings/write.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Variation {
  /** User-facing label shown in the variations sub-picker. */
  name: string;
  /** Full shell command string to execute. */
  command: string;
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

/**
 * A resolver throw (e.g. an unexpandable ${...} variable authored by hand)
 * degrades to "no variations" the same way a missing/corrupt file did before —
 * this runs on every rt run invocation and must never block it.
 */
export function loadVariations(
  repoIdentity: string | null,
): Record<string, Variation[]> {
  let raw: unknown;
  try {
    raw = getSetting<unknown>("rt.variations", { repoIdentity }).value;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, Variation[]>;
}

// ─── Write ──────────────────────────────────────────────────────────────────

export function saveVariation(
  repoIdentity: string | null,
  repoRoot: string,
  packagePath: string,
  script: string,
  variation: Variation,
): void {
  if (repoIdentity === null) return; // best effort: no identity, nowhere repo-scoped to write

  const key = variationKey(repoRoot, packagePath, script);
  const all = loadVariations(repoIdentity);
  const list = all[key] ?? [];
  all[key] = [...list, variation];

  try {
    setSetting("rt.variations", all, "team", { repoIdentity });
  } catch {
    // best effort — don't break the user's command over a write error
  }
}
