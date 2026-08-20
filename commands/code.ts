#!/usr/bin/env bun

/**
 * Editor-preference and launch machinery shared with `rt nav`.
 *
 * Tracks a per-repo editor choice and per-directory workspace-file choice
 * (~/.mattstack/rt/workspace-prefs.json), detects installed editors, and
 * launches one via its CLI command (code, cursor, zed, etc.), falling back
 * to the app bundle when the CLI shim is missing or broken.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { rtDir } from "../lib/rt-paths.ts";
import { dim, green, red, reset } from "../lib/tui.ts";

// ─── Preference storage (~/.mattstack/rt/workspace-prefs.json) ─────────────────────────

const PREFS_PATH = join(rtDir(), "workspace-prefs.json");

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
    const dir = rtDir();
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
// The single source of truth for "can we resolve without a picker?"

/**
 * Validates that a saved/known editor command can actually be launched.
 * Two forms exist:
 *   - app-bundle commands like `open -a "Antigravity"` → check the .app exists
 *   - CLI commands like `code` / `cursor` → `which` the binary
 * `which`-ing a full `open -a "App"` string fails (which tries to resolve the
 * args as commands too), which silently dropped saved app-bundle prefs.
 */
function isEditorCommandAvailable(command: string): boolean {
  const appMatch = command.match(/^open\s+-a\s+"(.+)"\s*$/);
  if (appMatch) {
    const appName = appMatch[1]!;
    const home = homedir();
    return existsSync(`/Applications/${appName}.app`)
      || existsSync(`${home}/Applications/${appName}.app`);
  }
  const binary = command.trim().split(/\s+/)[0]!;
  try { execSync(`which ${binary}`, { stdio: "pipe" }); return true; } catch { return false; }
}

/**
 * Returns the editor command if it can be determined without an interactive
 * picker (saved pref or exactly one editor installed). Returns null if a
 * picker is required.
 */
export function resolveEditorSync(prefs: Prefs, repoName: string): string | null {
  const saved = prefs.editors[repoName];
  if (saved && isEditorCommandAvailable(saved)) return saved;
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

// ─── Editor launch (with app-bundle fallback) ───────────────────────────────

function editorLabelFor(command: string): string {
  return KNOWN_EDITORS.find(e => e.command === command)?.label
    || KNOWN_APPS.find(a => a.command === command)?.label
    || command;
}

/**
 * If a bare-CLI editor command (e.g. `cursor`) is missing or broken but the
 * matching IDE is installed as an app bundle, returns the `open -a "App"`
 * command to launch it. Returns null when no app-bundle fallback applies
 * (already an app-bundle launch, unknown editor, or app not installed).
 *
 * This is what keeps editor launches landing on an actual IDE even when the
 * `cursor` on PATH is the cursor-agent shim, which is a dead end.
 */
export function appBundleFallback(editorCommand: string): string | null {
  if (/^open\s+-a\s+/.test(editorCommand)) return null; // already an app launch
  const binary = editorCommand.trim().split(/\s+/)[0]!;
  const label = KNOWN_EDITORS.find(e => e.command === binary)?.label;
  if (!label) return null;
  const app = KNOWN_APPS.find(a => a.label === label);
  const appName = app?.command.match(/"(.+)"/)?.[1];
  if (!appName) return null;
  const home = homedir();
  const exists = existsSync(`/Applications/${appName}.app`)
    || existsSync(`${home}/Applications/${appName}.app`);
  return exists ? app!.command : null;
}

/**
 * Launches `target` in `editor`. If a bare-CLI editor fails but its IDE is
 * installed as an app, retries via the app bundle. Returns the command that
 * actually opened the editor, or null if every attempt failed.
 */
function launchEditor(editor: string, target: string): string | null {
  try {
    execSync(`${editor} "${target}"`, { stdio: "inherit" });
    return editor;
  } catch {
    const fallback = appBundleFallback(editor);
    if (!fallback) return null;
    try {
      execSync(`${fallback} "${target}"`, { stdio: "inherit" });
      return fallback;
    } catch {
      return null;
    }
  }
}

// ─── Shared opener (used by rt nav) ─────────────────────────────────────────

export async function openDirectoryInEditor(dirPath: string): Promise<void> {
  const prefs = loadPrefs();
  const repoName = dirPath.split("/").pop() || "unknown";
  const editor = await ensureEditor(prefs, repoName);
  const editorLabel = editorLabelFor(editor);
  const target = await resolveWorkspaceTarget(dirPath, prefs);

  const used = launchEditor(editor, target);
  if (used) {
    if (used !== editor) { prefs.editors[repoName] = used; savePrefs(prefs); }
    console.error(`\n  ${green}✓${reset} Opened ${dirPath.split("/").pop()} in ${editorLabel}`);
  } else {
    console.error(`\n  ${red}Failed to open ${editorLabel}. Is '${editor}' CLI installed?${reset}`);
    process.exit(1);
  }
}
