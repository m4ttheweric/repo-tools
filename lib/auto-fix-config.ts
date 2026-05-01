/**
 * Per-repo auto-fix configuration.
 *
 * Path: ~/.rt/<repo>/auto-fix.json. Stores caps, denylist additions, the
 * enabled flag, and an optional explicit setupCommands override (otherwise
 * lockfile detection handles install).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface AutoFixConfig {
  /** Master toggle. When false, the daemon will not attempt auto-fixes for this repo. */
  enabled: boolean;
  /** Max number of files the agent's diff may touch. */
  fileCap: number;
  /** Max number of insertions+deletions across the diff. */
  lineCap: number;
  /** Patterns appended to DEFAULT_DENYLIST. */
  additionalDenylist: string[];
  /** Whether the agent is allowed to attempt test failures (vs. only lint/types). */
  allowTestFixes: boolean;
  /** Optional explicit setup command override. When omitted, lockfile detection runs. */
  setupCommands?: string[][];
}

export const DEFAULTS: AutoFixConfig = {
  enabled:            true,
  fileCap:            5,
  lineCap:            200,
  additionalDenylist: [],
  allowTestFixes:     false,
};

function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

export function autoFixConfigPath(repoName: string): string {
  return join(rtDir(), repoName, "auto-fix.json");
}

/** Load the config. Missing fields are filled from DEFAULTS. Malformed JSON returns DEFAULTS. */
export function loadAutoFixConfig(repoName: string): AutoFixConfig {
  const path = autoFixConfigPath(repoName);
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return { ...DEFAULTS };
    return {
      ...DEFAULTS,
      ...raw,
      additionalDenylist: Array.isArray(raw.additionalDenylist)
        ? raw.additionalDenylist
        : DEFAULTS.additionalDenylist,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAutoFixConfig(repoName: string, config: AutoFixConfig): void {
  const path = autoFixConfigPath(repoName);
  mkdirSync(join(rtDir(), repoName), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}
