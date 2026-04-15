/**
 * rt settings — Configure API keys, team defaults, and repo data.
 *
 * Subcommands (registered in cli.ts as a branch node):
 *   settings linear token   — set Linear API key
 *   settings linear team    — set default Linear team
 *   settings gitlab token   — set GitLab personal access token
 *   settings uninstall      — remove all rt data for current repo
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  loadSecrets,
  saveSecret,
  fetchTeams,
  getTeamConfig,
  saveTeamConfig,
} from "../lib/linear.ts";
import {
  loadNotificationPrefs,
  saveNotificationPrefs,
  NOTIFICATION_TYPES,
} from "../lib/notifier.ts";
import type { CommandContext } from "../lib/command-tree.ts";
import { installShellIntegration } from "../lib/shell-integration.ts";

// ─── Linear token ────────────────────────────────────────────────────────────

export async function setLinearToken(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.tsx");
  const secrets = loadSecrets();

  try {
    const linearKey = await textInput({
      message: "Linear API key (lin_api_...)",
      placeholder: secrets.linearApiKey
        ? "••• (already set, leave empty to keep)"
        : "lin_api_...",
    });

    if (!linearKey.trim()) {
      if (secrets.linearApiKey) {
        console.log(`  ${dim}keeping existing Linear API key${reset}`);
      } else {
        console.log(`  ${yellow}no key entered${reset}`);
      }
      return;
    }

    saveSecret("linearApiKey", linearKey.trim());
    console.log(`\n  ${green}✓${reset} Linear API key saved\n`);
  } catch {
    if (secrets.linearApiKey) {
      console.log(`  ${dim}keeping existing Linear API key${reset}`);
    }
  }
}

// ─── GitLab token ────────────────────────────────────────────────────────────

export async function setGitlabToken(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.tsx");
  const secrets = loadSecrets();

  try {
    const gitlabToken = await textInput({
      message: "GitLab personal access token",
      placeholder: secrets.gitlabToken
        ? "••• (already set, leave empty to keep)"
        : "glpat-...",
    });

    if (!gitlabToken.trim()) {
      if (secrets.gitlabToken) {
        console.log(`  ${dim}keeping existing GitLab token${reset}`);
      } else {
        console.log(`  ${yellow}no token entered${reset}`);
      }
      return;
    }

    saveSecret("gitlabToken", gitlabToken.trim());
    console.log(`\n  ${green}✓${reset} GitLab token saved\n`);
  } catch {
    if (secrets.gitlabToken) {
      console.log(`  ${dim}keeping existing GitLab token${reset}`);
    }
  }
}

// ─── Linear team ─────────────────────────────────────────────────────────────

export async function setLinearTeam(): Promise<void> {
  const secrets = loadSecrets();
  if (!secrets.linearApiKey) {
    console.log(`\n  ${yellow}Linear API key not configured${reset}`);
    console.log(`  ${dim}run: rt settings linear token${reset}\n`);
    return;
  }

  const result = await pickAndSaveTeam(secrets.linearApiKey);
  if (result) {
    console.log(`\n  ${green}✓${reset} default team set to ${bold}${result.teamKey}${reset}\n`);
  }
}

async function pickAndSaveTeam(apiKey: string): Promise<{ teamId: string; teamKey: string } | null> {
  console.log(`\n  ${dim}fetching teams…${reset}`);
  const teams = await fetchTeams(apiKey);

  if (teams.length === 0) {
    console.log(`  ${red}✗${reset} no teams found\n`);
    return null;
  }

  const { filterableSelect } = await import("../lib/rt-render.tsx");

  const selectedId = await filterableSelect({
    message: "Select your team",
    options: teams.map((t) => ({
      value: t.id,
      label: `${t.key}  ${t.name}`,
      hint: "",
    })),
  });

  if (!selectedId) return null;

  const team = teams.find((t) => t.id === selectedId);
  if (!team) return null;

  saveTeamConfig(team.id, team.key);
  return { teamId: team.id, teamKey: team.key };
}

// ─── Uninstall ───────────────────────────────────────────────────────────────

export async function uninstallRepo(args: string[], ctx: CommandContext): Promise<void> {
  const { repoName, repoRoot, dataDir } = ctx.identity!;
  const force = args.includes("--force") || args.includes("-f");

  // Check what exists
  const hasDataDir = existsSync(dataDir);
  let hooksRedirected = false;

  try {
    const hooksPath = execSync("git config core.hooksPath", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    hooksRedirected = hooksPath.includes(".rt");
  } catch { /* not set or error */ }

  if (!hasDataDir && !hooksRedirected) {
    console.log(`\n  ${dim}no rt footprint found for ${repoName}${reset}\n`);
    return;
  }

  // Show what will be removed
  console.log("");
  console.log(`  ${bold}${cyan}rt settings uninstall${reset}  ${dim}(${repoName})${reset}`);
  console.log("");

  if (hooksRedirected) {
    console.log(`  ${yellow}●${reset} restore core.hooksPath → .husky`);
  }
  if (hasDataDir) {
    console.log(`  ${yellow}●${reset} delete ~/.rt/${repoName}/`);
    console.log(`    ${dim}config, presets, baselines, hooks, build history${reset}`);
  }
  console.log("");

  // Confirm
  if (!force) {
    if (!process.stdin.isTTY) {
      console.log(`  ${yellow}use --force to skip confirmation${reset}\n`);
      process.exit(1);
    }

    const { confirm: inkConfirm } = await import("../lib/rt-render.tsx");
    const confirmed = await inkConfirm({
      message: "Remove all rt data for this repo?",
      initialValue: false,
    });

    if (!confirmed) {
      console.log(`\n  ${dim}cancelled${reset}\n`);
      process.exit(0);
    }
  }

  // Restore hooks
  if (hooksRedirected) {
    try {
      execSync('git config core.hooksPath ".husky"', {
        cwd: repoRoot,
        stdio: "pipe",
      });
      console.log(`  ${green}✓${reset} restored core.hooksPath → .husky`);
    } catch {
      console.log(`  ${red}✗${reset} failed to restore core.hooksPath`);
    }
  }

  // Delete data directory
  if (hasDataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      console.log(`  ${green}✓${reset} deleted ~/.rt/${repoName}/`);
    } catch (err) {
      console.log(`  ${red}✗${reset} failed to delete ~/.rt/${repoName}/: ${err}`);
    }
  }

  console.log(`\n  ${dim}all rt footprint removed for ${repoName}${reset}\n`);
}

// ─── Notification preferences ────────────────────────────────────────────────

export async function configureNotifications(): Promise<void> {
  const { execSync } = await import("child_process");
  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const prefs = loadNotificationPrefs();

  const options = NOTIFICATION_TYPES.map((t) => ({
    value: t.key,
    label: t.label,
    hint: t.description,
  }));

  const enabledKeys = NOTIFICATION_TYPES
    .filter((t) => prefs[t.key] !== false)
    .map((t) => t.key);

  const selected = await filterableMultiselect({
    message: "Notifications",
    options,
    initialValues: enabledKeys,
  });

  if (selected === null) {
    console.log(`\n  ${dim}cancelled — no changes${reset}\n`);
    return;
  }

  // Build new prefs: selected = enabled, unselected = disabled
  const newPrefs: Record<string, boolean> = {};
  for (const t of NOTIFICATION_TYPES) {
    newPrefs[t.key] = selected.includes(t.key);
  }

  saveNotificationPrefs(newPrefs);

  const enabledCount = selected.length;
  const totalCount = NOTIFICATION_TYPES.length;
  console.log(`\n  ${green}✓${reset} ${enabledCount}/${totalCount} notification types enabled`);

  console.log("");
}

// ─── Dev mode toggle ─────────────────────────────────────────────────────────

const DEV_MODE_WRAPPER = `${Bun.env.HOME}/.local/bin/rt`;
const DEV_MODE_CONFIG  = `${Bun.env.HOME}/.rt/dev-mode.json`;

function readDevModeConfig(): { sourcePath?: string } {
  try {
    return JSON.parse(readFileSync(DEV_MODE_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function currentMode(): "dev" | "prod" {
  return existsSync(DEV_MODE_WRAPPER) ? "dev" : "prod";
}

function detectSourcePath(): string | null {
  // When running from source (bun run cli.ts), import.meta.dir is the repo root
  const dir = import.meta.dir;
  if (dir && !dir.includes("/opt/homebrew") && !dir.includes("/usr/local") && !dir.startsWith("/$bunfs")) {
    // Walk up one level if we're in a subdirectory (e.g. commands/)
    const candidate = dir.endsWith("/commands") ? dir.replace(/\/commands$/, "") : dir;
    if (existsSync(`${candidate}/cli.ts`)) return candidate;
  }
  // Prefer saved config
  const saved = readDevModeConfig().sourcePath;
  if (saved && existsSync(`${saved}/cli.ts`)) return saved;

  // Fall back to common checkout locations
  const home = Bun.env.HOME!;
  for (const guess of [
    `${home}/Documents/GitHub/repo-tools`,
    `${home}/GitHub/repo-tools`,
    `${home}/code/repo-tools`,
    `${home}/src/repo-tools`,
    `${home}/repos/repo-tools`,
  ]) {
    if (existsSync(`${guess}/cli.ts`)) return guess;
  }
  return null;
}

function enableDevMode(sourcePath: string): void {
  // Save source path for future use (e.g. when running in prod mode)
  mkdirSync(`${Bun.env.HOME}/.rt`, { recursive: true });
  writeFileSync(DEV_MODE_CONFIG, JSON.stringify({ sourcePath }, null, 2));

  // Ensure ~/.local/bin exists
  mkdirSync(`${Bun.env.HOME}/.local/bin`, { recursive: true });

  // Write wrapper script
  const wrapper = [
    `#!/bin/zsh`,
    `exec bun run "${sourcePath}/cli.ts" "$@"`,
  ].join("\n") + "\n";
  writeFileSync(DEV_MODE_WRAPPER, wrapper, { mode: 0o755 });
}

function disableDevMode(): void {
  if (existsSync(DEV_MODE_WRAPPER)) {
    rmSync(DEV_MODE_WRAPPER);
  }
}

export async function toggleDevMode(args: string[]): Promise<void> {
  const { select } = await import("../lib/rt-render.tsx");

  const mode = currentMode();
  const sourcePath = detectSourcePath();

  // Show current state
  console.log("");
  const modeLabel = mode === "dev"
    ? `${green}dev${reset}  ${dim}(local source)${reset}`
    : `${bold}prod${reset}  ${dim}(Homebrew binary)${reset}`;
  console.log(`  ${bold}${cyan}rt dev mode${reset}  currently: ${modeLabel}`);
  if (mode === "dev" && sourcePath) {
    console.log(`  ${dim}source: ${sourcePath}${reset}`);
  }
  console.log("");

  // Resolve target from args or picker
  let target = args[0] as "dev" | "prod" | undefined;

  if (target !== "dev" && target !== "prod") {
    target = await select({
      message: "Switch to",
      options: [
        { value: "dev",  label: "Dev",  hint: `bun run cli.ts — uses local source` },
        { value: "prod", label: "Prod", hint: "Homebrew binary — uses installed release" },
      ],
    }) as "dev" | "prod";
  }

  if (target === "dev") {
    // Need a source path
    let resolvedPath = sourcePath;

    if (!resolvedPath) {
      const { textInput } = await import("../lib/rt-render.tsx");
      const defaultGuess = `${Bun.env.HOME}/Documents/GitHub/repo-tools`;
      const entered = await textInput({
        message: "Path to repo-tools source directory",
        defaultValue: defaultGuess,
      });
      const path = entered?.trim();
      if (!path) {
        console.log(`  ${red}✗${reset} no path entered\n`);
        return;
      }
      if (!existsSync(`${path}/cli.ts`)) {
        console.log(`  ${red}✗${reset} cli.ts not found at: ${path}\n`);
        return;
      }
      resolvedPath = path;
    }

    enableDevMode(resolvedPath!);

    // Ensure shell integration exists (idempotent — handles zsh/bash/fish)
    const shellResult = installShellIntegration();
    if (shellResult.written) {
      console.log(`  ${green}✓${reset} added shell integration to ${shellResult.rcPath}`);
    }

    console.log(`  ${green}✓${reset} dev mode enabled`);
    console.log(`  ${dim}wrapper → ${DEV_MODE_WRAPPER}${reset}`);
    console.log(`  ${dim}source  → ${resolvedPath}${reset}`);
    console.log(`  ${dim}restart your terminal (or: source ${shellResult.rcPath ?? "~/.zshrc"}) to activate${reset}`);

  } else {
    disableDevMode();
    console.log(`  ${green}✓${reset} prod mode enabled  ${dim}(Homebrew binary is now active)${reset}`);
  }

  console.log("");
}
