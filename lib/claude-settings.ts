import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface HookWriteResult {
  changed: boolean;
}

export type ClaudeHookStatus = { installed: false } | { installed: true; command: string; binaryExists: boolean };

const CREATE_SUFFIX = " worktree claude-hook";
const REMOVE_SUFFIX = " worktree claude-hook --remove";

interface HookEntry {
  hooks: Array<{ type: string; command: string }>;
}

interface ClaudeSettings {
  hooks?: {
    WorktreeCreate?: HookEntry[];
    WorktreeRemove?: HookEntry[];
    [event: string]: HookEntry[] | undefined;
  };
  [key: string]: unknown;
}

function readSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read Claude settings at ${settingsPath}: ${err}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Malformed JSON in Claude settings at ${settingsPath}`);
  }
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function isOwnedBy(entry: HookEntry, suffix: string): boolean {
  return entry.hooks.every((h) => h.command.endsWith(suffix));
}

function dropOwned(entries: HookEntry[] | undefined, suffix: string): HookEntry[] {
  return (entries ?? []).filter((e) => !isOwnedBy(e, suffix));
}

export function installClaudeWorktreeHooks(settingsPath: string, rtBin: string): HookWriteResult {
  const settings = readSettings(settingsPath);
  const before = JSON.stringify(settings);

  settings.hooks ??= {};
  const create = dropOwned(settings.hooks.WorktreeCreate, CREATE_SUFFIX);
  create.push({ hooks: [{ type: "command", command: `${rtBin} worktree claude-hook` }] });
  settings.hooks.WorktreeCreate = create;

  const remove = dropOwned(settings.hooks.WorktreeRemove, REMOVE_SUFFIX);
  remove.push({ hooks: [{ type: "command", command: `${rtBin} worktree claude-hook --remove` }] });
  settings.hooks.WorktreeRemove = remove;

  const after = JSON.stringify(settings);
  const changed = before !== after;
  if (changed) writeSettings(settingsPath, settings);
  return { changed };
}

export function uninstallClaudeWorktreeHooks(settingsPath: string): HookWriteResult {
  const settings = readSettings(settingsPath);
  const before = JSON.stringify(settings);

  if (settings.hooks) {
    settings.hooks.WorktreeCreate = dropOwned(settings.hooks.WorktreeCreate, CREATE_SUFFIX);
    settings.hooks.WorktreeRemove = dropOwned(settings.hooks.WorktreeRemove, REMOVE_SUFFIX);
  }

  const after = JSON.stringify(settings);
  const changed = before !== after;
  if (changed) writeSettings(settingsPath, settings);
  return { changed };
}

export function claudeWorktreeHookStatus(settingsPath: string): ClaudeHookStatus {
  const settings = readSettings(settingsPath);
  const create = settings.hooks?.WorktreeCreate ?? [];
  const owned = create.find((e) => isOwnedBy(e, CREATE_SUFFIX));
  if (!owned) return { installed: false };

  const command = owned.hooks[0]?.command ?? "";
  const binary = command.split(" ")[0] ?? "";
  return { installed: true, command, binaryExists: existsSync(binary) };
}
