#!/usr/bin/env bun

/**
 * rt code — Open a worktree in your preferred editor.
 *
 * Two-step picker:
 *   1. Pick a worktree (context-aware: worktrees if in a known repo, all repos otherwise)
 *   2. Pick a workspace file if multiple exist (choice is saved for next time)
 *
 * Opens via editor CLI command (code, cursor, zed, etc.)
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  getRepoIdentity, getKnownRepos, updateRepoIndex, type KnownRepo,
} from "../lib/repo.ts";
import { pickWorktreeWithSwitch, pickFromAllRepos, isSwitchRepo } from "../lib/pickers.ts";

// ─── Preference storage (~/.rt/workspace-prefs.json) ─────────────────────────

const PREFS_PATH = join(homedir(), ".rt", "workspace-prefs.json");

interface Prefs {
  editors: Record<string, string>;
  workspaces: Record<string, string>;
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(readFileSync(PREFS_PATH, "utf8"));
    return {
      editors: raw.editors || {},
      workspaces: raw.workspaces || raw.entries || {},
    };
  } catch {
    return { editors: {}, workspaces: {} };
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    const dir = join(homedir(), ".rt");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
  } catch { /* best-effort */ }
}

// ─── Editor detection ────────────────────────────────────────────────────────

interface EditorOption {
  command: string;
  label: string;
}

const KNOWN_EDITORS: EditorOption[] = [
  { command: "code", label: "VS Code" },
  { command: "cursor", label: "Cursor" },
  { command: "zed", label: "Zed" },
  { command: "codium", label: "VSCodium" },
  { command: "windsurf", label: "Windsurf" },
  { command: "subl", label: "Sublime Text" },
  { command: "atom", label: "Atom" },
  { command: "idea", label: "IntelliJ IDEA" },
  { command: "webstorm", label: "WebStorm" },
];

function detectInstalledEditors(): EditorOption[] {
  return KNOWN_EDITORS.filter((e) => {
    try {
      execSync(`which ${e.command}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
}

async function ensureEditor(prefs: Prefs, repoName: string): Promise<string> {
  const saved = prefs.editors[repoName];
  if (saved) {
    try {
      execSync(`which ${saved}`, { stdio: "pipe" });
      return saved;
    } catch { /* saved editor no longer available */ }
  }

  const installed = detectInstalledEditors();

  if (installed.length === 0) {
    console.log(`\n  ${red}No supported editor CLI found.${reset}`);
    console.log(`  ${dim}Install one of: code, cursor, zed, codium, subl${reset}\n`);
    process.exit(1);
  }

  if (installed.length === 1) {
    prefs.editors[repoName] = installed[0]!.command;
    savePrefs(prefs);
    return prefs.editors[repoName]!;
  }

  const { select } = await import("../lib/rt-render.tsx");
  const selected = await select({
    message: `Which editor for ${repoName}?`,
    options: installed.map(e => ({
      value: e.command,
      label: e.label,
      hint: e.command,
    })),
  });

  prefs.editors[repoName] = selected;
  savePrefs(prefs);
  return selected;
}

// ─── Workspace file resolution ───────────────────────────────────────────────

async function resolveWorkspaceTarget(dirPath: string, prefs: Prefs): Promise<string> {
  const saved = prefs.workspaces[dirPath];

  if (saved) {
    const candidate = join(dirPath, saved);
    if (existsSync(candidate)) return candidate;
  }

  let wsFiles: string[];
  try {
    wsFiles = readdirSync(dirPath)
      .filter(f => f.endsWith(".code-workspace"))
      .sort();
  } catch {
    return dirPath;
  }

  if (wsFiles.length === 0) return dirPath;

  if (wsFiles.length === 1) {
    prefs.workspaces[dirPath] = wsFiles[0]!;
    savePrefs(prefs);
    return join(dirPath, wsFiles[0]!);
  }

  const { select } = await import("../lib/rt-render.tsx");
  const options = [
    ...wsFiles.map(f => ({ value: f, label: f, hint: "workspace file" })),
    { value: "__folder__", label: "Open folder without workspace file", hint: "" },
  ];

  const selected = await select({
    message: "Multiple workspace files found",
    options,
  });

  if (selected !== "__folder__") {
    prefs.workspaces[dirPath] = selected;
    savePrefs(prefs);
    return join(dirPath, selected);
  }

  return dirPath;
}

// ─── Untracked repo picker ──────────────────────────────────────────────────

async function pickWithCurrentUntracked(
  identity: { repoName: string; repoRoot: string },
  repos: KnownRepo[],
): Promise<string> {
  const { select } = await import("../lib/rt-render.tsx");

  const OPEN_THIS = "__open_this__";

  const options = [
    {
      value: OPEN_THIS,
      label: `${identity.repoName} (this repo — will be tracked)`,
      hint: identity.repoRoot.replace(process.env.HOME || "", "~"),
    },
    ...repos.map(r => ({
      value: r.repoName,
      label: r.repoName,
      hint: r.worktrees.length > 1
        ? `${r.worktrees.length} worktrees`
        : r.worktrees[0]?.path.replace(process.env.HOME || "", "~") || "",
    })),
  ];

  const picked = await select({
    message: "Pick a repo to open",
    options,
  });

  if (picked === OPEN_THIS) {
    updateRepoIndex(identity.repoName, identity.repoRoot);
    console.log(`  Now tracking ${identity.repoName}`);
    return identity.repoRoot;
  }

  const selectedRepo = repos.find(r => r.repoName === picked)!;

  if (selectedRepo.worktrees.length === 1) {
    return selectedRepo.worktrees[0]!.path;
  }

  const { pickWorktreeFromRepo } = await import("../lib/repo.ts");
  return pickWorktreeFromRepo(selectedRepo, `${selectedRepo.repoName} worktrees`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(`\n  ${yellow}rt code must be run interactively${reset}\n`);
    process.exit(1);
  }

  const pickMode = args.includes("-p") || args.includes("--pick");
  const prefs = loadPrefs();
  const repos = getKnownRepos();
  const identity = getRepoIdentity();
  const currentRepo = identity
    ? repos.find(r => r.repoName === identity.repoName) ?? null
    : null;

  let selectedPath: string;

  if (!pickMode && currentRepo) {
    selectedPath = identity!.repoRoot;
  } else if (pickMode && currentRepo && currentRepo.worktrees.length > 1) {
    const result = await pickWorktreeWithSwitch(currentRepo, identity!.repoRoot);
    selectedPath = isSwitchRepo(result)
      ? await pickFromAllRepos(repos)
      : result;
  } else if (!currentRepo && identity) {
    selectedPath = await pickWithCurrentUntracked(identity, repos);
  } else {
    selectedPath = await pickFromAllRepos(repos);
  }

  // Derive repo name from selected path
  const freshRepos = getKnownRepos();
  const selectedRepo = freshRepos.find(r =>
    r.worktrees.some(wt => wt.path === selectedPath),
  );
  const repoName = selectedRepo?.repoName || selectedPath.split("/").pop() || "unknown";

  const editor = await ensureEditor(prefs, repoName);
  const editorLabel = KNOWN_EDITORS.find(e => e.command === editor)?.label || editor;

  const target = await resolveWorkspaceTarget(selectedPath, prefs);

  try {
    execSync(`${editor} "${target}"`, { stdio: "inherit" });
    const label = target.endsWith(".code-workspace")
      ? target.split("/").pop()
      : selectedPath.split("/").pop();
    console.log(`\n  ${green}✓${reset} Opened ${label} in ${editorLabel}`);
  } catch {
    console.log(`\n  ${red}Failed to open ${editorLabel}. Is '${editor}' CLI installed?${reset}`);
    console.log(`  ${dim}You can reset your editor preference by deleting ~/.rt/workspace-prefs.json${reset}\n`);
    process.exit(1);
  }
}
