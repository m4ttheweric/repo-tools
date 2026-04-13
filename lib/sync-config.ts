/**
 * rt sync config — Auto-resolve rules and post-resolve steps.
 *
 * Config lives at ~/.rt/<repo>/sync.json (zero footprint — never in the repo).
 * The rules define how to handle known-trivial conflicts during rebases:
 *   - glob pattern → strategy (theirs/ours)
 *   - per-rule postResolve steps (e.g. "pnpm install" after lockfile resolve)
 *
 * Only the postResolve steps for rules that actually matched are executed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AutoResolveRule {
  /** Glob pattern to match against conflicted file paths (relative to repo root). */
  glob: string;
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

// ─── Load / Save ─────────────────────────────────────────────────────────────

/**
 * Load sync config from ~/.rt/<repo>/sync.json.
 * Returns default config if the file doesn't exist.
 *
 * @param dataDir - The repo's data directory (e.g. ~/.rt/<repo>)
 */
export function loadSyncConfig(dataDir: string): SyncConfig {
  const configPath = join(dataDir, "sync.json");
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG };

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return {
      autoResolve: Array.isArray(raw.autoResolve) ? raw.autoResolve : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save sync config to ~/.rt/<repo>/sync.json.
 */
export function saveSyncConfig(dataDir: string, config: SyncConfig): void {
  const configPath = join(dataDir, "sync.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
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
  // Lazy-load picomatch — it's a fast glob matcher.
  // Falls back to basic matching if not available.
  let matcher: (glob: string, path: string) => boolean;

  try {
    // Bun supports the picomatch API via built-in Bun.Glob
    matcher = (glob, path) => new Bun.Glob(glob).match(path);
  } catch {
    // Fallback: exact match + simple ** prefix matching
    matcher = (glob, path) => {
      if (glob === path) return true;
      if (glob.startsWith("**/")) {
        const suffix = glob.slice(3);
        return path.endsWith(suffix) || path.includes(`/${suffix}`);
      }
      return false;
    };
  }

  for (const rule of rules) {
    if (matcher(rule.glob, filePath)) return rule;
  }
  return null;
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
