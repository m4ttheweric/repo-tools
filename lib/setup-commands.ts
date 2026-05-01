/**
 * Lockfile-driven install command detection.
 *
 * Used by the auto-fix engine when `setupCommands` isn't explicitly set in
 * `~/.rt/<repo>/auto-fix.json`. The first matching lockfile in priority order
 * wins. Returns `null` if no known lockfile is present — the agent will then
 * either bootstrap itself or report skipped if it can't proceed.
 */

import { existsSync } from "fs";
import { join } from "path";

interface Detector {
  lockfile: string;
  command:  string[];
}

// Order matters: priority is left-to-right when multiple lockfiles coexist.
const DETECTORS: Detector[] = [
  { lockfile: "bun.lock",          command: ["bun", "install"] },
  { lockfile: "bun.lockb",         command: ["bun", "install"] },
  { lockfile: "pnpm-lock.yaml",    command: ["pnpm", "install", "--frozen-lockfile"] },
  { lockfile: "yarn.lock",         command: ["yarn", "install", "--frozen-lockfile"] },
  { lockfile: "package-lock.json", command: ["npm", "ci"] },
  { lockfile: "Gemfile.lock",      command: ["bundle", "install"] },
  { lockfile: "go.sum",            command: ["go", "mod", "download"] },
  { lockfile: "requirements.txt",  command: ["pip", "install", "-r", "requirements.txt"] },
];

/** Returns the install command for the worktree, or null if no lockfile is detected. */
export function detectInstallCommand(worktreePath: string): string[] | null {
  for (const d of DETECTORS) {
    if (existsSync(join(worktreePath, d.lockfile))) return d.command;
  }
  return null;
}
