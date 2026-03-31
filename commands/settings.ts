/**
 * rt settings — Configure API keys, team defaults, and repo data.
 *
 * Subcommands (registered in cli.ts as a branch node):
 *   settings linear token   — set Linear API key
 *   settings linear team    — set default Linear team
 *   settings gitlab token   — set GitLab personal access token
 *   settings uninstall      — remove all rt data for current repo
 */

import { existsSync, rmSync } from "fs";
import { execSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  loadSecrets,
  saveSecret,
  fetchTeams,
  getTeamConfig,
  saveTeamConfig,
} from "../lib/linear.ts";
import { requireIdentity } from "../lib/repo.ts";

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

export async function uninstallRepo(args: string[]): Promise<void> {
  const identity = await requireIdentity("rt settings uninstall");

  const { repoName, repoRoot, dataDir } = identity;
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
