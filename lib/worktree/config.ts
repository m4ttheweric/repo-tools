/**
 * Worktree config: repo overlay + app-level, with a one-time compat seed.
 *
 * Two files, two owners:
 *  - `~/.rt/repos/<repo>/config.json` — repo-config.ts owns most of this file
 *    (setup/clean/startScript/open). This module reads the SAME file but only
 *    ever looks at its optional "worktrees" key, and never writes it.
 *  - `~/.rt/worktrees.json` — owned entirely by this module. `{enabled,
 *    killProcesses}`, seeded once from the legacy `~/.rt/parking-lot.json`
 *    (section 11.1 retires the old file after the seed) when the new file is
 *    absent and the old one exists. Both default to true, matching
 *    parking-lot-config.ts's legacy `raw?.enabled !== false` semantics.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { readJson, writeJson } from "../json-store.ts";
import { repoDataDir, rtDir } from "../rt-paths.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ReadyStep {
  run: string;
  when?: string;
}

export interface WorktreeRepoConfig {
  onDeck: number; // default 0
  namePool?: string[];
  root: string; // default join(repoPath, ".worktrees")
  branchFormat: string; // default "<ticket>-<slug>"
  ready: ReadyStep[]; // declared domain steps ONLY (implicit install prepended at resolve time)
}

export interface WorktreeAppConfig {
  enabled: boolean;
  killProcesses: boolean;
}

// ─── Repo overlay ────────────────────────────────────────────────────────────

interface RawRepoConfigFile {
  worktrees?: Partial<WorktreeRepoConfig>;
}

/**
 * Reads the "worktrees" key of ~/.rt/repos/<repo>/config.json. repo-config.ts
 * owns every other key in that file; this never writes it.
 */
export function loadWorktreeRepoConfig(repoName: string, repoPath: string): WorktreeRepoConfig {
  const path = join(repoDataDir(repoName), "config.json");
  const raw = readJson<RawRepoConfigFile>(path, {});
  const declared = raw.worktrees ?? {};

  const cfg: WorktreeRepoConfig = {
    onDeck: declared.onDeck ?? 0,
    root: declared.root ?? join(repoPath, ".worktrees"),
    branchFormat: declared.branchFormat ?? "<ticket>-<slug>",
    ready: declared.ready ?? [],
  };
  if (declared.namePool) cfg.namePool = declared.namePool;
  return cfg;
}

// ─── Implicit install ladder ─────────────────────────────────────────────────

type Manager = "pnpm" | "bun" | "yarn" | "npm";

const MANAGER_STEP: Record<Manager, ReadyStep> = {
  pnpm: { run: "pnpm install --side-effects-cache", when: "changed:pnpm-lock.yaml" },
  bun: { run: "bun install", when: "changed:bun.lock*" },
  yarn: { run: "yarn install", when: "changed:yarn.lock" },
  npm: { run: "npm install", when: "changed:package-lock.json" },
};

function detectManager(repoPath: string): Manager | null {
  const packageJsonPath = join(repoPath, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager : undefined;
    if (declared) {
      const prefix = declared.split("@")[0];
      if (prefix === "pnpm" || prefix === "bun" || prefix === "yarn" || prefix === "npm") {
        return prefix;
      }
    }
  } catch {
    // malformed package.json falls through to lockfile sniffing
  }

  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return "bun";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "package-lock.json"))) return "npm";
  return "npm";
}

/**
 * ladder (spec §5): no package.json → null; packageManager field prefix
 * pnpm|bun|yarn|npm → step; else lockfile sniff pnpm-lock.yaml→pnpm,
 * bun.lock|bun.lockb→bun, yarn.lock→yarn, package-lock.json→npm; else npm.
 */
export function resolveImplicitInstall(repoPath: string): ReadyStep | null {
  const manager = detectManager(repoPath);
  return manager ? MANAGER_STEP[manager] : null;
}

/**
 * Implicit install first UNLESS cfg.ready already declares its own install
 * step for the detected manager (run starts with "<manager> install", e.g.
 * "pnpm install --side-effects-cache") — only an install step replaces the
 * implicit one; any other declared command for that manager (e.g. "pnpm
 * lint") does not suppress it. Otherwise cfg.ready in order.
 */
export function resolveReadySteps(cfg: WorktreeRepoConfig, repoPath: string): ReadyStep[] {
  const manager = detectManager(repoPath);
  if (!manager) return cfg.ready;

  const installPrefix = `${manager} install`;
  const alreadyDeclared = cfg.ready.some((step) => step.run.startsWith(installPrefix));
  if (alreadyDeclared) return cfg.ready;

  return [MANAGER_STEP[manager], ...cfg.ready];
}

// ─── App-level config ────────────────────────────────────────────────────────

const APP_CONFIG_DEFAULTS: WorktreeAppConfig = { enabled: true, killProcesses: true };

/**
 * ~/.rt/worktrees.json; if absent AND ~/.rt/parking-lot.json exists, seed from
 * it once (write the new file), then read the new file. Defaults
 * { enabled: true, killProcesses: true }.
 */
export function loadWorktreeAppConfig(): WorktreeAppConfig {
  const path = join(rtDir(), "worktrees.json");
  const legacyPath = join(rtDir(), "parking-lot.json");

  if (!existsSync(path) && existsSync(legacyPath)) {
    const legacy = readJson<{ enabled?: boolean; killProcesses?: boolean }>(legacyPath, {});
    const seeded: WorktreeAppConfig = {
      enabled: legacy.enabled !== false,
      killProcesses: legacy.killProcesses !== false,
    };
    writeJson(path, seeded);
  }

  return readJson<WorktreeAppConfig>(path, APP_CONFIG_DEFAULTS);
}
