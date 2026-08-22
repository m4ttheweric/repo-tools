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
/** Closes every block this module appends (the shell-integration block and the .zshenv precedence block) — the anchor `removeShellIntegration`/`removeZshenvPrecedence` need to strip a block precisely instead of guessing where it ends. A block written before this marker existed has no closing anchor; removal reports that case as `manual` rather than guessing at its extent. */
export const END_MARKER = "# rt — end";
export const ZSHENV_MARKER = "# mattstack — PATH precedence";

// ─── Shell detection ──────────────────────────────────────────────────────────

export type ShellType = "zsh" | "bash" | "fish" | "unknown";

/** Pure mapping from a raw $SHELL value to a ShellType — the one place this repo names the three supported shells, so a shell added here is honored everywhere that classifies one (this module, and lib/setup/validators/rt-health.ts's tool.shell row, which calls this directly over Probes' `p.env.SHELL` instead of reading real process.env). */
export function detectShellFrom(shellEnv: string): ShellType {
  if (shellEnv.endsWith("zsh"))  return "zsh";
  if (shellEnv.endsWith("bash")) return "bash";
  if (shellEnv.endsWith("fish")) return "fish";
  return "unknown";
}

export function detectShell(): ShellType {
  return detectShellFrom(process.env.SHELL ?? "");
}

// ─── RC file targets ──────────────────────────────────────────────────────────

/** Pure rc-file mapping against an explicit `homeDir` — the shape shellRcPath(shell) below composes with call-time home(). Also reused by rt-health.ts's tool.shell row against Probes' `p.home` instead of real HOME. */
export function shellRcPathFor(shell: ShellType, homeDir: string): string | null {
  switch (shell) {
    case "zsh":  return join(homeDir, ".zshrc");
    case "bash": return join(homeDir, ".bash_profile");
    case "fish": return join(homeDir, ".config/fish/conf.d/rt.fish");
    default:     return null;
  }
}

export function shellRcPath(shell: ShellType): string | null {
  return shellRcPathFor(shell, home());
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
    END_MARKER,
    "",
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
    END_MARKER,
    "",
  ].join("\n");
}

/** ~/.zshenv — sourced by EVERY zsh invocation (interactive or not, login or not), unlike ~/.zshrc's interactive-only scope. Keeping ~/.local/bin ahead of PATH here (not just in the .zshrc block) is what makes `rt`/bundled tools win over a same-named copy for non-interactive shells (scripts, editor integrations) too. */
function zshenvPath(): string {
  return join(home(), ".zshenv");
}

function zshenvBlock(): string {
  return ["", ZSHENV_MARKER, 'export PATH="$HOME/.local/bin:$PATH"', END_MARKER, ""].join("\n");
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

// ─── PATH precedence (~/.zshenv) + block removal ───────────────────────────

/**
 * Writes the PATH-precedence block to ~/.zshenv, idempotent via
 * ZSHENV_MARKER. Only meaningful for zsh (the other shells' rc files
 * already carry their own PATH line via installShellIntegration), so this
 * is unconditional on shell type — a non-zsh machine simply never sources
 * ~/.zshenv, and writing it anyway costs nothing.
 */
export interface ZshenvPrecedenceResult {
  alreadyInstalled: boolean;
  written: boolean;
  error?: string;
}

export function installZshenvPrecedence(): ZshenvPrecedenceResult {
  const path = zshenvPath();
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (existing.includes(ZSHENV_MARKER)) {
      return { alreadyInstalled: true, written: false };
    }
    writeFileSync(path, existing + zshenvBlock());
    return { alreadyInstalled: false, written: true };
  } catch (err: any) {
    // An unreadable/unwritable ~/.zshenv (permissions, a directory sitting at
    // that path) is an expected environment condition, not a bug — mirrors
    // installShellIntegration's own {error} shape rather than throwing.
    return { alreadyInstalled: false, written: false, error: err?.message ?? String(err) };
  }
}

export interface RemoveBlockResult {
  removed: boolean;
  /** True when `marker` is present but has no `END_MARKER` after it — a block written before END_MARKER existed. Its extent can't be known safely, so nothing is touched; the caller must strip it by hand. */
  manual?: boolean;
}

/**
 * Strips exactly the block `marker`..`END_MARKER` (inclusive) from `path`,
 * plus the one leading blank line the block's own generator prefixes it
 * with and the one trailing newline after END_MARKER — restoring the file
 * to exactly what it was before the block was appended, whatever unrelated
 * content sits before or after it. Shared by `removeShellIntegration` and
 * `removeZshenvPrecedence`, which differ only in which file/marker they target.
 */
function removeMarkedBlock(path: string, marker: string): RemoveBlockResult {
  if (!existsSync(path)) return { removed: false };

  const content = readFileSync(path, "utf8");
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) return { removed: false };

  const endIdx = content.indexOf(END_MARKER, markerIdx);
  if (endIdx === -1) return { removed: false, manual: true };

  let start = markerIdx;
  if (content[start - 1] === "\n") start -= 1; // the block's own leading blank line

  let end = endIdx + END_MARKER.length;
  if (content[end] === "\n") end += 1; // the block's own trailing newline

  writeFileSync(path, content.slice(0, start) + content.slice(end));
  return { removed: true };
}

/** The inverse of `installShellIntegration` — removes exactly what it wrote, leaving unrelated rc-file content untouched. A block installed before END_MARKER existed can't be located precisely; that case reports `manual: true` instead of guessing. */
export function removeShellIntegration(): RemoveBlockResult {
  const shell = detectShell();
  const rcPath = shellRcPath(shell);
  if (!rcPath) return { removed: false };
  return removeMarkedBlock(rcPath, MARKER);
}

/** The inverse of `installZshenvPrecedence`. */
export function removeZshenvPrecedence(): RemoveBlockResult {
  return removeMarkedBlock(zshenvPath(), ZSHENV_MARKER);
}
