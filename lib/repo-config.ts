/**
 * Per-repo config — ~/.rt/<repo>/config.json.
 *
 * Stores setup steps, clean commands, and dev preferences.
 * Port discovery is handled automatically by the daemon.
 * Includes the first-run config wizard.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SetupStep {
  label: string;
  /** Shell command. Use "auto" for build-deps (auto-wired turbo build). */
  command: string;
  /** Optional subdirectory to run from (relative to repo root). */
  cwd?: string;
}

export interface RepoConfig {
  setup: SetupStep[];
  clean: string[];
  startScript: string;
  open: { base: string };
}

const DEFAULT_CONFIG: RepoConfig = {
  setup: [],
  clean: [],
  startScript: "start",
  open: { base: "" },
};

// ─── Load / Save ─────────────────────────────────────────────────────────────

/**
 * Load the repo config from ~/.rt/<repo>/config.json.
 * Merges with defaults for any missing fields.
 */
export function loadRepoConfig(dataDir: string): RepoConfig {
  const configPath = join(dataDir, "config.json");

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8"));
      return {
        setup: raw.setup ?? DEFAULT_CONFIG.setup,
        clean: raw.clean ?? DEFAULT_CONFIG.clean,
        startScript: raw.startScript ?? DEFAULT_CONFIG.startScript,
        open: raw.open ?? DEFAULT_CONFIG.open,
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  return { ...DEFAULT_CONFIG };
}

/**
 * Load config, running the interactive wizard on first use if in a TTY.
 */
export async function loadOrCreateRepoConfig(
  dataDir: string,
  repoRoot: string,
  repoName: string,
): Promise<RepoConfig> {
  const configPath = join(dataDir, "config.json");

  if (existsSync(configPath)) {
    return loadRepoConfig(dataDir);
  }

  if (process.stdin.isTTY) {
    const config = await runConfigWizard(repoRoot, repoName);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return config;
  } else {
    const config = { ...DEFAULT_CONFIG };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return config;
  }
}

export function saveRepoConfig(dataDir: string, config: RepoConfig): void {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config, null, 2));
}

// ─── First-run config wizard ─────────────────────────────────────────────────

async function runConfigWizard(repoRoot: string, repoName: string): Promise<RepoConfig> {
  const { textInput, confirm: inkConfirm } = await import("./rt-render.tsx");

  console.log(`\n  First-time setup for ${repoName}\n`);

  // ── Setup steps ─────────────────────────────────────────────────────────────

  const setup: SetupStep[] = [];

  const wantBuildDeps = await inkConfirm({
    message: "Add 'build deps' setup step? (auto-wired turbo build for selected apps)",
    initialValue: true,
  });

  if (wantBuildDeps) {
    setup.push({ label: "build deps", command: "auto" });
  }

  let addMore = true;
  while (addMore) {
    const wantStep = await inkConfirm({
      message: setup.length === 0
        ? "Add a setup step? (runs before dev servers start)"
        : "Add another setup step?",
      initialValue: setup.length === 0,
    });

    if (!wantStep) {
      addMore = false;
      break;
    }

    try {
      const label = await textInput({ message: "Step label", placeholder: "deploy db" });
      const cwd = await textInput({ message: "Subdirectory? (leave empty for repo root)", placeholder: "apps/backend" }).catch(() => "");
      const command = await textInput({ message: "Shell command", placeholder: "pnpm deploy-db" });

      const step: SetupStep = { label, command };
      if (cwd) step.cwd = cwd;
      setup.push(step);
    } catch {
      addMore = false;
    }
  }

  // ── Clean commands ──────────────────────────────────────────────────────────

  const clean: string[] = [];
  try {
    const cleanInput = await textInput({
      message: "Clean-mode commands (comma separated, or press Enter to skip)",
      placeholder: "find . -name .parcel-cache -type d -exec rm -rf {} +",
    });
    clean.push(...cleanInput.split(",").map(s => s.trim()).filter(Boolean));
  } catch { /* user skipped */ }

  // ── Build config ────────────────────────────────────────────────────────────

  const config: RepoConfig = {
    setup,
    clean,
    startScript: "start",
    open: { base: "" },
  };

  console.log(`\n  Config saved to ~/.rt/${repoName}/config.json\n`);
  return config;
}
