/**
 * TMUX: openPopup + openTempPane
 *
 * Imperative tmux integration for launching child processes in split panes
 * or floating popups. These functions have side effects and require tmux.
 *
 * ─── openPopup (ephemeral) ────────────────────────────────────────────────────
 * Opens a floating `display-popup -E` above the runner layout.
 * The popup closes automatically when the command exits.
 * Use for: pickers, editors, one-off scripts (rt branch, rt run, editors).
 *
 * ─── openTempPane (persistent) ───────────────────────────────────────────────
 * Opens a `split-window -v` in the current or target pane.
 * Returns the pane ID for tracking. The pane persists until explicitly killed.
 * Use for: interactive shells, service log viewers.
 *
 * Source: commands/runner.tsx openPopup / openTempPane (lines 90-153)
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir as _homedir, tmpdir as _tmpdir } from "node:os";
import { mkdirSync as _mkdirSync, writeFileSync as _writeFileSync, rmSync as _rmSync } from "node:fs";

// ─── Registry for Esc-able shell panes' ZDOTDIR temp dirs ────────────────────

/**
 * Set of ZDOTDIR temp dirs created for Esc-able shell panes.
 * The shell's trap handles normal exits; this is a safety net for SIGHUP/SIGKILL
 * (e.g. runner quitting while a shell pane is open).
 */
const _zdotdirRegistry = new Set<string>();

process.once("exit", () => {
  for (const dir of _zdotdirRegistry) {
    try { _rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── openTempPane ─────────────────────────────────────────────────────────────

export interface TempPaneOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** tmux pane ID to split relative to. Defaults to the active pane. */
  target?: string;
  /**
   * If true, wraps the command in a custom .zshrc that binds Esc → exit.
   * Use for interactive shells where Esc should close the pane.
   * Do NOT use for editors (Esc is a normal editing key in vim/nano).
   */
  escToClose?: boolean;
}

/**
 * Opens a vertical tmux split pane running `cmd`.
 * Always targets `opts.target` (usually the display pane) so the runner pane
 * is never resized and the Rezi layout stays intact.
 *
 * @returns The tmux pane ID (e.g. "%5"), or undefined if tmux failed.
 *
 * @example
 * ```typescript
 * // Open an Esc-to-close shell at the entry's target directory:
 * const paneId = openTempPane(process.env.SHELL ?? "zsh", {
 *   cwd: entry.targetDir,
 *   target: displayPaneId,
 *   escToClose: true,
 * });
 * ```
 */
export function openTempPane(
  cmd: string,
  opts: TempPaneOptions = {},
): string | undefined {
  let resolvedCmd = cmd;

  if (opts.escToClose) {
    const zdotdir = join(_tmpdir(), `rt-shell-${Date.now()}`);
    const rcFile  = join(zdotdir, ".zshrc");
    const realRc  = join(_homedir(), ".zshrc");
    _mkdirSync(zdotdir, { recursive: true });
    _zdotdirRegistry.add(zdotdir);
    _writeFileSync(rcFile, [
      `# rt runner — sources real .zshrc then wires Esc→close silently`,
      `[[ -f "${realRc}" ]] && ZDOTDIR="${_homedir()}" source "${realRc}"`,
      `esc-exit() { exit 0; }`,
      `zle -N esc-exit`,
      `bindkey '^[' esc-exit`,
      `trap 'rm -rf "${zdotdir}"' EXIT`,
      `trap 'rm -rf "${zdotdir}"; exit' HUP TERM`,
    ].join("\n"));
    resolvedCmd = `ZDOTDIR=${zdotdir} ${cmd}`;
  }

  const args = ["split-window", "-v", "-P", "-F", "#{pane_id}"];
  if (opts.target) args.push("-t", opts.target);
  if (opts.cwd)    args.push("-c", opts.cwd);
  args.push(resolvedCmd);

  const result = spawnSync("tmux", args, { encoding: "utf8" });
  return result.stdout?.trim() || undefined;
}

// ─── openPopup ────────────────────────────────────────────────────────────────

export interface PopupOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Popup width. Default "80%". Can be an absolute number (chars) or percentage. */
  width?: string;
  /** Popup height. Default "80%". Can be an absolute number (rows) or percentage. */
  height?: string;
  /** Title shown in the popup border (left-aligned). */
  title?: string;
  /** Hint shown right-aligned in the border. Default "Esc to close". */
  hint?: string;
}

/**
 * Opens an ephemeral floating tmux popup (`display-popup -E`) above the runner.
 * The popup closes automatically when the command exits.
 * This call **blocks** until the popup is dismissed.
 *
 * The popup uses a darker background (`bg=#1a1b26`) and cyan border to
 * visually distinguish it from the runner panes behind it.
 *
 * @example
 * ```typescript
 * // Open a branch picker:
 * openPopup(`${process.execPath} ${CLI_PATH} branch`, {
 *   cwd: entry.worktree,
 *   title: "rt branch",
 *   width: "100",
 *   height: "20",
 * });
 *
 * // Open an editor:
 * openPopup(`nvim '${tmpFile}'`, {
 *   title: "edit command",
 *   hint: ":wq to save",
 *   width: "100",
 *   height: "12",
 * });
 * ```
 */
export function openPopup(cmd: string, opts: PopupOptions = {}): void {
  const w     = opts.width  ?? "80%";
  const h     = opts.height ?? "80%";
  const title = opts.title  ?? "";
  const hint  = opts.hint   ?? "Esc to close";

  const titleFmt = title
    ? ` ${title} #[align=right] ${hint} `
    : "";

  const args: string[] = [
    "display-popup", "-E",
    "-w", w, "-h", h,
    "-b", "rounded",
    "-s", "bg=#1a1b26",  // darker bg to distinguish from runner panes
    "-S", "fg=cyan",     // border color
  ];
  if (titleFmt)  args.push("-T", titleFmt);
  if (opts.cwd)  args.push("-d", opts.cwd);
  args.push("sh", "-c", cmd);

  spawnSync("tmux", args, { encoding: "utf8" });
}
