/**
 * Path denylist + scope caps for auto-fix.
 *
 * Pure helpers — no I/O. Used by the daemon's post-agent validation step
 * (and by the agent's prompt as the explicit list of paths it cannot touch).
 *
 * Pattern matching uses Bun's built-in Glob (same as elsewhere in rt).
 */

export const DEFAULT_DENYLIST: string[] = [
  // Lockfiles (deps must not be auto-modified)
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  // Migrations
  "migrations/**",
  "db/migrate/**",
  // CI / build infra
  ".gitlab-ci.yml",
  ".github/workflows/**",
  "Dockerfile",
  "docker-compose*.yml",
  // Infra
  "infra/**",
  "terraform/**",
  // Env files
  ".env",
  ".env.*",
];

/**
 * Returns true if `path` matches any pattern in `patterns`. Patterns may
 * contain glob wildcards (`*`, `**`).
 */
export function matchesDenylist(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (new Bun.Glob(pattern).match(path)) return true;
  }
  return false;
}

export interface ScopeCapInputs {
  files:   number;
  lines:   number;
  fileCap: number;
  lineCap: number;
}

export type ScopeCapViolation =
  | { kind: "files"; actual: number; cap: number }
  | { kind: "lines"; actual: number; cap: number };

/** Returns null when no violation, or the first violation found. */
export function enforceScopeCaps(input: ScopeCapInputs): ScopeCapViolation | null {
  if (input.files > input.fileCap) {
    return { kind: "files", actual: input.files, cap: input.fileCap };
  }
  if (input.lines > input.lineCap) {
    return { kind: "lines", actual: input.lines, cap: input.lineCap };
  }
  return null;
}
