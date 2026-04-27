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

// App bundle fallbacks for when the CLI isn't in PATH (macOS only).
// command is passed directly to execSync, e.g. `open -a "Cursor" "<target>"`.
const KNOWN_APPS: EditorOption[] = [
  { command: 'open -a "Cursor"', label: "Cursor" },
  { command: 'open -a "Visual Studio Code"', label: "VS Code" },
  { command: 'open -a "Zed"', label: "Zed" },
  { command: 'open -a "Antigravity"', label: "Antigravity" },
  { command: 'open -a "Windsurf"', label: "Windsurf" },
  { command: 'open -a "Sublime Text"', label: "Sublime Text" },
  { command: 'open -a "WebStorm"', label: "WebStorm" },
];

function detectInstalledEditors(): EditorOption[] {
  const { existsSync } = require("fs");
  const { homedir } = require("os");
  const home = homedir();

  const cliEditors = KNOWN_EDITORS.filter((e) => {
    try {
      execSync(`which ${e.command}`, { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  });
  if (cliEditors.length > 0) return cliEditors;

  // Fall back to app bundle detection (macOS)
  return KNOWN_APPS.filter((e) => {
    const appName = e.command.match(/"(.+)"/)?.[1];
    if (!appName) return false;
    return (
      existsSync(`/Applications/${appName}.app`) ||
      existsSync(`${home}/Applications/${appName}.app`)
    );
  });
}

// ─── Sync resolvers (no prompts) ────────────────────────────────────────────
// These are the single source of truth for "can we resolve without a picker?"
// Both the async entry point and willPrompt() call these — no drift possible.

/**
 * Returns the editor command if it can be determined without an interactive
 * picker (saved pref or exactly one editor installed). Returns null if a
 * picker is required.
 */
export function resolveEditorSync(prefs: Prefs, repoName: string): string | null {
  const saved = prefs.editors[repoName];
  if (saved) {
    try { execSync(`which ${saved}`, { stdio: "pipe" }); return saved; } catch {}
  }
  const installed = detectInstalledEditors();
  if (installed.length === 1) return installed[0]!.command;
  return null; // 0 = will error, 2+ = picker needed
}

/**
 * Returns the workspace target path if it can be determined without an
 * interactive picker (saved pref, zero files, or exactly one file).
 * Returns null if a picker is required (multiple .code-workspace files).
 */
export function resolveWorkspaceSync(dirPath: string, prefs: Prefs): string | null {
  const saved = prefs.workspaces[dirPath];
  if (saved) {
    const candidate = join(dirPath, saved);
    if (existsSync(candidate)) return candidate;
  }
  try {
    const wsFiles = readdirSync(dirPath).filter(f => f.endsWith(".code-workspace")).sort();
    if (wsFiles.length === 0) return dirPath;
    if (wsFiles.length === 1) return join(dirPath, wsFiles[0]!); // auto-save on first use
    return null; // multiple files — picker required
  } catch {
    return dirPath;
  }
}

// ─── Async resolvers (with pickers) ─────────────────────────────────────────

async function ensureEditor(prefs: Prefs, repoName: string): Promise<string> {
  // Fast path: sync resolver covers the common case
  const fast = resolveEditorSync(prefs, repoName);
  if (fast) {
    // Auto-save if it was detected (not yet persisted)
    if (!prefs.editors[repoName]) {
      prefs.editors[repoName] = fast;
      savePrefs(prefs);
    }
    return fast;
  }

  const installed = detectInstalledEditors();
  if (installed.length === 0) {
    console.log(`\n  ${red}No supported editor CLI found.${reset}`);
    console.log(`  ${dim}Install one of: code, cursor, zed, codium, subl${reset}\n`);
    process.exit(1);
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

async function resolveWorkspaceTarget(dirPath: string, prefs: Prefs): Promise<string> {
  // Fast path: sync resolver covers the common case
  const fast = resolveWorkspaceSync(dirPath, prefs);
  if (fast) {
    // Auto-save single workspace file if not yet persisted
    const wsFile = fast !== dirPath ? fast.split("/").pop()! : null;
    if (wsFile && !prefs.workspaces[dirPath]) {
      prefs.workspaces[dirPath] = wsFile;
      savePrefs(prefs);
    }
    return fast;
  }

  // Multiple workspace files — show picker
  const wsFiles = readdirSync(dirPath).filter(f => f.endsWith(".code-workspace")).sort();
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
  const { filterableSelect } = await import("../lib/rt-render.tsx");

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

  const picked = await filterableSelect({
    message: "Pick a repo to open",
    options,
  });

  if (!picked) {
    process.exit(0);
  }

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

// ─── Picker pre-flight check ─────────────────────────────────────────────────

/**
 * Returns true if opening `rt code` for the given directory would require
 * showing an interactive picker.
 *
 * Calls the same sync resolvers used by openInEditor — shared logic, no drift.
 */
export function willPrompt(cwd: string): boolean {
  const prefs = loadPrefs();
  const repoName = cwd.split("/").pop() || "unknown";
  if (resolveEditorSync(prefs, repoName) === null) return true;
  if (resolveWorkspaceSync(cwd, prefs) === null) return true;
  return false;
}

// ─── Shared opener (used by rt nav) ─────────────────────────────────────────

export async function openDirectoryInEditor(dirPath: string): Promise<void> {
  const prefs = loadPrefs();
  const repoName = dirPath.split("/").pop() || "unknown";
  const editor = await ensureEditor(prefs, repoName);
  const editorLabel = KNOWN_EDITORS.find(e => e.command === editor)?.label || editor;
  const target = await resolveWorkspaceTarget(dirPath, prefs);
  try {
    execSync(`${editor} "${target}"`, { stdio: "inherit" });
    console.error(`\n  ${green}✓${reset} Opened ${dirPath.split("/").pop()} in ${editorLabel}`);
  } catch {
    console.error(`\n  ${red}Failed to open ${editorLabel}. Is '${editor}' CLI installed?${reset}`);
    process.exit(1);
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function openInEditor(args: string[]): Promise<void> {

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
