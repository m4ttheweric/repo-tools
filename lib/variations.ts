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
 * Reads are best-effort — a broken/missing store value degrades to empty
 * rather than blocking the user's actual command invocation. Writes are NOT
 * silently swallowed: `saveVariation` reports success/failure (including a
 * team-store refusal, e.g. zero or multiple local team stores — see
 * settings/write.ts's team-selection rule) so a caller can tell the user the
 * truth instead of pretending the save landed.
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

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: "no-identity" }
  | { ok: false; reason: "write-failed"; message: string };

/**
 * Appends `variation` under its key and writes the whole map to team scope
 * (ruling: team.repo) — but the base it merges onto is the RESOLVED value
 * across every scope the key allows, not just what's already in the team
 * store. Variations are meant to live in team scope only, so this only
 * matters if one was ever hand-authored into user or machine: the next save
 * here copies the whole merged map — that foreign variation included — into
 * the team store too. Accepted, not guarded.
 */
export function saveVariation(
  repoIdentity: string | null,
  repoRoot: string,
  packagePath: string,
  script: string,
  variation: Variation,
): SaveResult {
  if (repoIdentity === null) return { ok: false, reason: "no-identity" };

  const key = variationKey(repoRoot, packagePath, script);
  const all = loadVariations(repoIdentity);
  const list = all[key] ?? [];
  all[key] = [...list, variation];

  try {
    setSetting("rt.variations", all, "team", { repoIdentity });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "write-failed", message: err instanceof Error ? err.message : String(err) };
  }
}
