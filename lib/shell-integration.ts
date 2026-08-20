/**
 * Shell integration helper — detects the user's shell and writes
 * rt's PATH + rtcd alias to the appropriate rc file.
 *
 * Supported shells:
 *   zsh  → ~/.zshrc
 *   bash → ~/.bash_profile  (macOS login shell convention)
 *   fish → ~/.config/fish/conf.d/rt.fish  (fish uses conf.d for packages)
 *
 * All writes are idempotent (guarded by a marker comment).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Call-time HOME (mirrors lib/rt-paths.ts's home()): resolved on every call,
// not baked in at module load. A module-load-time HOME let a test's temp-HOME
// setup race this module's import and nearly touched the real ~/.zshrc.
function home(): string {
  return process.env.HOME ?? homedir();
}

const MARKER = "# rt — repo tools";
const HISTORY_HOOK_MARKER = "# rt — shell history hook";

// ─── Shell detection ──────────────────────────────────────────────────────────

type ShellType = "zsh" | "bash" | "fish" | "unknown";

export function detectShell(): ShellType {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("zsh"))  return "zsh";
  if (shell.endsWith("bash")) return "bash";
  if (shell.endsWith("fish")) return "fish";
  return "unknown";
}

// ─── RC file targets ──────────────────────────────────────────────────────────

export function shellRcPath(shell: ShellType): string | null {
  switch (shell) {
    case "zsh":  return join(home(), ".zshrc");
    case "bash": return join(home(), ".bash_profile");
    case "fish": return join(home(), ".config/fish/conf.d/rt.fish");
    default:     return null;
  }
}

// ─── Integration blocks ───────────────────────────────────────────────────────

function posixBlock(): string {
  return [
    "",
    MARKER,
    'export PATH="$HOME/.local/bin:$PATH"',
    'rt-cd() { local dir=$(rt cd 2>/dev/null); [ -n "$dir" ] && cd "$dir"; }',
    "alias rtcd='rt-cd'",
    "",
    posixHistoryHook(),
  ].join("\n");
}

function fishBlock(): string {
  // fish uses its own syntax — no export, no alias, different function form
  return [
    "",
    MARKER,
    "fish_add_path $HOME/.local/bin",
    "function rtcd",
    "    set dir (rt cd 2>/dev/null)",
    '    if test -n "$dir"',
    "        builtin cd $dir",
    "    end",
    "end",
    "",
    fishHistoryHook(),
  ].join("\n");
}

// ─── History hook blocks (also callable standalone for existing installs) ──────

function posixHistoryHook(): string {
  return [
    HISTORY_HOOK_MARKER,
    "# Replay rt run commands in shell history so up-arrow recalls the actual",
    "# command (e.g. \"npm run test\") instead of \"rt run\".",
    "_rt_history_hook() {",
    '  if [[ -f ~/.mattstack/rt/last-run-command ]]; then',
    '    local cmd=$(<~/.mattstack/rt/last-run-command)',
    '    if [[ -n "$cmd" ]]; then',
    '      if [[ -n "$ZSH_VERSION" ]]; then',
    '        print -s "$cmd"',
    "      else",
    '        history -s "$cmd"',
    "      fi",
    "    fi",
    '    rm -f ~/.mattstack/rt/last-run-command',
    "  fi",
    "}",
    'if [[ -n "$ZSH_VERSION" ]]; then',
    "  precmd_functions+=(_rt_history_hook)",
    "else",
    '  PROMPT_COMMAND="_rt_history_hook;${PROMPT_COMMAND}"',
    "fi",
    "",
  ].join("\n");
}

function fishHistoryHook(): string {
  return [
    HISTORY_HOOK_MARKER,
    "# Replay rt run commands in fish history.",
    "function _rt_history_hook --on-event fish_prompt",
    "    if test -f ~/.mattstack/rt/last-run-command",
    "        set cmd (cat ~/.mattstack/rt/last-run-command)",
    '        if test -n "$cmd"',
    "            # fish has no direct history injection; write to the history file",
    "            # in fish's yaml format and merge.",
    "            set fish_hist $__fish_user_data_dir",
    '            test -n "$fish_hist" || set fish_hist ~/.local/share/fish',
    '            echo "- cmd: $cmd" >> $fish_hist/fish_history',
    '            echo "  when: "(date +%s) >> $fish_hist/fish_history',
    "            builtin history merge 2>/dev/null",
    "        end",
    "        rm -f ~/.mattstack/rt/last-run-command",
    "    end",
    "end",
    "",
  ].join("\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ShellIntegrationResult {
  shell: ShellType;
  rcPath: string;
  alreadyInstalled: boolean;
  written: boolean;
  error?: string;
}

/**
 * Write rt shell integration to the user's rc file.
 * Safe to call multiple times — idempotent via the MARKER string.
 */
export function installShellIntegration(): ShellIntegrationResult {
  const shell = detectShell();
  const rcPath = shellRcPath(shell);

  if (!rcPath) {
    return { shell, rcPath: "(unknown)", alreadyInstalled: false, written: false,
             error: `Unrecognised shell: ${process.env.SHELL ?? "not set"}. Add ~/.local/bin to your PATH manually.` };
  }

  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";

  if (existing.includes(MARKER)) {
    return { shell, rcPath, alreadyInstalled: true, written: false };
  }

  const block = shell === "fish" ? fishBlock() : posixBlock();

  try {
    // fish conf.d/ may not exist yet
    if (shell === "fish") {
      mkdirSync(join(home(), ".config/fish/conf.d"), { recursive: true });
    }
    writeFileSync(rcPath, existing + block);
    return { shell, rcPath, alreadyInstalled: false, written: true };
  } catch (err: any) {
    return { shell, rcPath, alreadyInstalled: false, written: false,
             error: err?.message ?? String(err) };
  }
}

/**
 * Install JUST the history hook into the user's rc file, independently of the
 * main integration block. Idempotent via HISTORY_HOOK_MARKER. Called from
 * runCommand so existing users get the hook on their next `rt run` without
 * needing to re-run post-install.
 */
export function ensureHistoryHook(): boolean {
  const shell = detectShell();
  const rcPath = shellRcPath(shell);
  if (!rcPath) return false;

  try {
    const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
    if (existing.includes(HISTORY_HOOK_MARKER)) return true; // already installed

    const block = shell === "fish" ? fishHistoryHook() : posixHistoryHook();
    if (shell === "fish") {
      mkdirSync(join(home(), ".config/fish/conf.d"), { recursive: true });
    }
    writeFileSync(rcPath, existing + block);
    return true;
  } catch {
    return false;
  }
}
