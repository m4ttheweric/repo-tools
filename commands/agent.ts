#!/usr/bin/env bun

/**
 * rt agent — Launch a CLI coding agent in a worktree.
 *
 * Target selection:
 *   - Default: use the current git repo/worktree when already inside one.
 *   - --pick/-p: force the repo/worktree picker before launching.
 *   - --here/-h: use the exact current directory.
 * Then pick an agent (always asks — no preference saved).
 *
 * Execs the agent CLI with cwd set to the selected path, inheriting stdio.
 */

import { execSync, spawn } from "child_process";
import { homedir } from "os";
import { dim, green, red, reset } from "../lib/tui.ts";
import { getRepoRoot, getRepoIdentity, getKnownRepos, type KnownRepo, type RepoIdentity } from "../lib/repo.ts";
import { pickWorktreeWithSwitch, pickFromAllRepos, isSwitchRepo } from "../lib/pickers.ts";

// ─── Agent detection ─────────────────────────────────────────────────────────

interface AgentOption {
  command: string;
  label: string;
}

const KNOWN_AGENTS: AgentOption[] = [
  { command: "claude",       label: "Claude Code" },
  { command: "cursor-agent", label: "Cursor CLI" },
  { command: "codex",        label: "OpenAI Codex" },
  { command: "gemini",       label: "Gemini CLI" },
  { command: "aider",        label: "Aider" },
  { command: "goose",        label: "Goose" },
  { command: "opencode",     label: "OpenCode" },
  { command: "amp",          label: "Amp" },
];

function detectInstalledAgents(): AgentOption[] {
  return KNOWN_AGENTS.filter((a) => {
    try {
      execSync(`command -v ${a.command}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
}

async function pickAgent(repoName: string): Promise<string> {
  const installed = detectInstalledAgents();
  if (installed.length === 0) {
    console.log(`\n  ${red}No supported agent CLI found.${reset}`);
    console.log(`  ${dim}Install one of: ${KNOWN_AGENTS.map(a => a.command).join(", ")}${reset}\n`);
    process.exit(1);
  }

  if (installed.length === 1) return installed[0]!.command;

  const { filterableSelect } = await import("../lib/rt-render.tsx");
  const picked = await filterableSelect({
    message: `Agent for ${repoName}`,
    options: installed.map(a => ({
      value: a.command,
      label: a.label,
      hint: a.command,
    })),
  });
  if (!picked) process.exit(0);
  return picked;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export interface AgentTargetDeps {
  cwd: string;
  repos: KnownRepo[];
  identity: RepoIdentity | null;
  repoRoot: string | null;
  pickWorktreeWithSwitch: typeof pickWorktreeWithSwitch;
  pickFromAllRepos: typeof pickFromAllRepos;
}

export async function resolveAgentTargetPath(
  args: string[],
  deps?: Partial<AgentTargetDeps>,
): Promise<string> {
  const here = args.includes("--here") || args.includes("-h");
  const pickMode = args.includes("--pick") || args.includes("-p");
  const cwd = deps?.cwd ?? process.cwd();

  if (here) return cwd;

  const identity = deps && "identity" in deps ? deps.identity ?? null : getRepoIdentity();
  const repoRoot = deps && "repoRoot" in deps
    ? deps.repoRoot ?? identity?.repoRoot ?? null
    : identity?.repoRoot ?? getRepoRoot();
  const repos = deps?.repos ?? getKnownRepos();
  const currentRepo = identity
    ? repos.find(r => r.repoName === identity.repoName) ?? null
    : null;

  if (!pickMode && repoRoot) return repoRoot;

  if (pickMode && currentRepo && currentRepo.worktrees.length > 1) {
    const result = await (deps?.pickWorktreeWithSwitch ?? pickWorktreeWithSwitch)(currentRepo, identity!.repoRoot);
    return isSwitchRepo(result)
      ? await (deps?.pickFromAllRepos ?? pickFromAllRepos)(repos)
      : result;
  }

  return (deps?.pickFromAllRepos ?? pickFromAllRepos)(repos);
}

export async function launchAgent(args: string[]): Promise<void> {
  const selectedPath = await resolveAgentTargetPath(args);

  const freshRepos = getKnownRepos();
  const selectedRepo = freshRepos.find(r =>
    r.worktrees.some(wt => wt.path === selectedPath),
  );
  const repoName = selectedRepo?.repoName || selectedPath.split("/").pop() || "unknown";

  const agent = await pickAgent(repoName);
  const agentLabel = KNOWN_AGENTS.find(a => a.command === agent)?.label || agent;

  console.log(`\n  ${green}→${reset} ${agentLabel} in ${dim}${selectedPath.replace(homedir(), "~")}${reset}\n`);

  const child = spawn(agent, [], {
    cwd: selectedPath,
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.log(`\n  ${red}Failed to launch ${agentLabel}: ${err.message}${reset}\n`);
    process.exit(1);
  });
}
