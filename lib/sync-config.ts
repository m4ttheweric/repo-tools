/**
 * rt sync config — Auto-resolve rules and post-resolve steps.
 *
 * Resolved through the settings resolver (`rt.sync`, team.repo scope). The
 * rules define how to handle known-trivial conflicts during rebases:
 *   - glob pattern → strategy (theirs/ours)
 *   - per-rule postResolve steps (e.g. "pnpm install" after lockfile resolve)
 *
 * Only the postResolve steps for rules that actually matched are executed.
 */

import { getSetting } from "./settings/resolve.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AutoResolveRule {
  /**
   * Glob pattern(s) to match against conflicted file paths (relative to repo root).
   * Accepts a single pattern or an array — the rule matches if any pattern matches.
   */
  glob: string | string[];
  /** Resolution strategy: "theirs" accepts incoming changes, "ours" keeps current. */
  strategy: "theirs" | "ours";
  /**
   * Shell commands to run after this rule resolves a conflict.
   * Only runs once per rebase even if the glob matches multiple files.
   * Example: ["pnpm install"] after a lockfile conflict.
   */
  postResolve?: string[];
}

export interface SyncConfig {
  autoResolve: AutoResolveRule[];
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SyncConfig = {
  autoResolve: [],
};

// ─── Load ────────────────────────────────────────────────────────────────────

/**
 * The resolved `rt.sync` value for a repo, or defaults when nothing resolves.
 * A resolver throw (e.g. an unexpandable ${...} variable authored by hand)
 * degrades the same way a missing/corrupt file did before — this runs on
 * every rebase/dispose call and must never take that down.
 */
export function loadSyncConfig(repoIdentity: string | null): SyncConfig {
  try {
    const raw = getSetting<unknown>("rt.sync", { repoIdentity }).value;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { autoResolve?: unknown }).autoResolve)) {
      return { autoResolve: (raw as { autoResolve: AutoResolveRule[] }).autoResolve };
    }
    return { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ─── Rule Matching ───────────────────────────────────────────────────────────

/**
 * Match a file path against auto-resolve rules.
 * Uses picomatch for glob matching.
 *
 * @returns The matching rule, or null if no rule matches.
 */
export function matchRule(
  filePath: string,
  rules: AutoResolveRule[],
): AutoResolveRule | null {
  // Bun.Glob can throw at match time on an invalid pattern (hand-authored
  // into rt.sync) — catch per call so a bad rule degrades to basic matching
  // instead of blowing up mid-rebase. (The previous try/catch wrapped only
  // the closure *creation*, which can never throw.)
  const basicMatch = (glob: string, path: string): boolean => {
    if (glob === path) return true;
    if (glob.startsWith("**/")) {
      const suffix = glob.slice(3);
      return path.endsWith(suffix) || path.includes(`/${suffix}`);
    }
    return false;
  };
  const matcher = (glob: string, path: string): boolean => {
    try {
      return new Bun.Glob(glob).match(path);
    } catch {
      return basicMatch(glob, path);
    }
  };

  for (const rule of rules) {
    const globs = Array.isArray(rule.glob) ? rule.glob : [rule.glob];
    if (globs.some((g) => matcher(g, filePath))) return rule;
  }
  return null;
}

/** Normalize a rule's glob field to an array of patterns. */
export function ruleGlobs(rule: AutoResolveRule): string[] {
  return Array.isArray(rule.glob) ? rule.glob : [rule.glob];
}

/**
 * Check all conflicted files against auto-resolve rules.
 *
 * @returns An object with matched and unmatched files.
 */
export function classifyConflicts(
  conflictedFiles: string[],
  rules: AutoResolveRule[],
): {
  /** Files that matched a rule and can be auto-resolved. */
  matched: { file: string; rule: AutoResolveRule }[];
  /** Files that didn't match any rule and need manual resolution. */
  unmatched: string[];
} {
  const matched: { file: string; rule: AutoResolveRule }[] = [];
  const unmatched: string[] = [];

  for (const file of conflictedFiles) {
    const rule = matchRule(file, rules);
    if (rule) {
      matched.push({ file, rule });
    } else {
      unmatched.push(file);
    }
  }

  return { matched, unmatched };
}

/**
 * Collect unique postResolve steps from matched rules (deduped, order-preserving).
 */
export function collectPostResolveSteps(
  matched: { file: string; rule: AutoResolveRule }[],
): string[] {
  const seen = new Set<string>();
  const steps: string[] = [];

  for (const { rule } of matched) {
    if (rule.postResolve) {
      for (const step of rule.postResolve) {
        if (!seen.has(step)) {
          seen.add(step);
          steps.push(step);
        }
      }
    }
  }

  return steps;
}
