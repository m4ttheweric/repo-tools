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

const HOME = homedir();
const MARKER = "# rt — repo tools";

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
    case "zsh":  return join(HOME, ".zshrc");
    case "bash": return join(HOME, ".bash_profile");
    case "fish": return join(HOME, ".config/fish/conf.d/rt.fish");
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
      mkdirSync(join(HOME, ".config/fish/conf.d"), { recursive: true });
    }
    writeFileSync(rcPath, existing + block);
    return { shell, rcPath, alreadyInstalled: false, written: true };
  } catch (err: any) {
    return { shell, rcPath, alreadyInstalled: false, written: false,
             error: err?.message ?? String(err) };
  }
}
