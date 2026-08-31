/**
 * rt commit — GitHub Desktop-style staging, discarding, and commit flow.
 *
 * Presents an fzf multi-picker of all changed files (staged + unstaged).
 * All files are pre-selected; deselect what you don't want. The right-side
 * fzf preview pane shows a live diff for the focused file, rendered via delta
 * (with fallback to plain `git diff --color=always` if delta is not installed).
 *
 * Operations (mirrors GitHub Desktop's Changes tab):
 *   - space: stage/unstage (toggle inclusion in commit)
 *   - ctrl-d: discard working-tree changes for selected files
 *   - enter: commit staged selection
 *   - esc: abort
 *
 * Git mechanics live in lib/commit-ops.ts (tested there):
 *   1. Parse `git status --porcelain -z` → build file list
 *   2. fzf multi-picker with diff preview on the right (60% width)
 *   3a. ctrl-d → confirm → discardChanges → back to step 1
 *   3b. enter → syncStagingArea → commit message → commitStaged → done
 *   3c. esc → abort
 */

import { spawnSync } from "child_process";
import { fzfHeightArgs } from "../lib/fzf-select.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CommandContext } from "../lib/command-tree.ts";
import { ensureFzf } from "../lib/fzf.ts";
import { T, toAnsiFg, toHex } from "../lib/tui/palette.ts";
import {
  getChangedFiles,
  discardChanges,
  syncStagingArea,
  commitStaged,
  type ChangedFile,
} from "../lib/commit-ops.ts";

// ─── Display ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  A: "32",
  M: "33",
  D: "31",
  R: "34",
  C: "34",
  U: "35",
};

/** Two-char status badge, colored by the dominant status letter. Handles any
 *  porcelain combination (M , MM, AM, RM, ...) instead of a fixed lookup. */
function fileLabel(f: ChangedFile): string {
  if (f.rawStatus === "??") return `  \x1b[2m??\x1b[0m  ${f.path}`;
  const letter = f.isStaged ? f.rawStatus[0]! : f.rawStatus[1]!;
  const color = f.isStaged ? STATUS_COLORS[letter] ?? "0" : "2";
  return `  \x1b[${color}m${f.rawStatus}\x1b[0m  ${f.path}`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error && "stderr" in err) {
    const stderr = String((err as Error & { stderr: unknown }).stderr).trim();
    if (stderr) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Inline confirmation before discarding. Mirrors GitHub Desktop's
 *  DiscardChanges dialog — always confirms, never discards silently. */
async function confirmDiscard(paths: string[]): Promise<boolean> {
  const label =
    paths.length === 1 ? `"${paths[0]}"` : `${paths.length} files`;
  process.stderr.write("\n");

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    // The prompt must go through rl.question — readline's line refresh
    // clears the current line, erasing any text written directly before it.
    rl.question(`  discard changes to ${label}? [y/N] `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "y" || trimmed === "yes");
    });
  });
}

// ─── delta / diff detection ───────────────────────────────────────────────────

/** Returns the diff command to pipe into for colorised output.
 *  Uses delta if available, otherwise falls back to nothing (git produces ANSI itself). */
function deltaPipeCmd(): string {
  const result = spawnSync("which", ["delta"], { stdio: "pipe" });
  if (result.status !== 0) return "";
  // delta flags tuned for the preview pane.
  // --syntax-theme intentionally omitted — let delta use its configured default
  // to avoid quote-escaping issues when the theme name contains spaces.
  return "| delta --no-gitconfig --paging=never --width=variable --line-numbers";
}

/**
 * Build the preview command for fzf's --preview flag.
 *
 * Writes the bash script to a temp file so that real newlines are preserved
 * exactly as written — bypassing the multi-layer quoting that occurs when a
 * script is embedded inline (JSON.stringify \n escapes collapse to 'n' when
 * the shell parser rescans them, producing errors like "thenn: not found").
 *
 * Returns { cmd, cleanup } — call cleanup() after fzf exits.
 */
function buildPreviewCmd(
  cwd: string,
  pipe: string,
): { cmd: string; cleanup: () => void } {
  const script = [
    `f="$1"`,
    `xy="\${f%%:*}"`,
    `p="\${f#*:}"`,
    `cd ${JSON.stringify(cwd)}`,
    `if [ "$xy" = "??" ]; then`,
    `  git diff --color=always --no-index /dev/null "$p" 2>/dev/null ${pipe} || cat "$p"`,
    `else`,
    `  STAGED=$(git diff --cached --color=always -- "$p" 2>/dev/null ${pipe})`,
    `  UNSTAGED=$(git diff --color=always -- "$p" 2>/dev/null ${pipe})`,
    `  if [ -n "$STAGED" ] && [ -n "$UNSTAGED" ]; then`,
    `    printf '\\e[1;34m── staged ──\\e[0m\\n'`,
    `    printf '%s\\n' "$STAGED"`,
    `    printf '\\n\\e[1;33m── unstaged ──\\e[0m\\n'`,
    `    printf '%s\\n' "$UNSTAGED"`,
    `  elif [ -n "$STAGED" ]; then`,
    `    printf '%s\\n' "$STAGED"`,
    `  else`,
    `    printf '%s\\n' "$UNSTAGED"`,
    `  fi`,
    `fi`,
  ].join("\n");

  const scriptPath = join(tmpdir(), `rt-preview-${process.pid}.sh`);
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });

  const cleanup = () => {
    process.removeListener("exit", cleanup);
    try { unlinkSync(scriptPath); } catch { /* already gone — ignore */ }
  };

  // Safety net: delete the script if the process exits before fzf does.
  process.once("exit", cleanup);

  return { cmd: `bash ${JSON.stringify(scriptPath)} {1}`, cleanup };
}

// ─── fzf picker ───────────────────────────────────────────────────────────────

interface PickerResult {
  exitKey: string;  // "" = enter, "ctrl-d" = discard
  paths: string[];
}

/**
 * Show fzf multi-picker with live diff preview.
 * Returns { exitKey, paths } where exitKey is the key that dismissed fzf,
 * or null if the user cancelled (esc).
 */
function runFilePicker(cwd: string, files: ChangedFile[]): PickerResult | null {
  const fzf = ensureFzf();
  const pipe = deltaPipeCmd();
  const { cmd: previewCmd, cleanup: cleanupPreview } = buildPreviewCmd(cwd, pipe);

  // Build the input: "<xy>:<path>\t<displayLabel>"
  const input = files
    .map((f) => `${f.rawStatus}:${f.path}\t${fileLabel(f)}`)
    .join("\n");

  const result = spawnSync(
    fzf,
    [
      "--multi",
      "--ansi",
      "--with-nth=2..",         // display label col; value col is hidden
      "--delimiter=\t",
      "--layout=reverse",
      ...fzfHeightArgs(),
      "--border=left",
      "--no-separator",
      "--prompt=  filter: ",
      `--header=${toAnsiFg(T.pink)}rt commit\x1b[0m`,
      "--header-first",
      "--info=inline-right",
      "--footer=space: stage  tab: toggle+next  ctrl-a: toggle-all  ctrl-d: discard  enter: commit  esc: abort",
      "--no-mouse",
      "--bind=space:toggle,tab:toggle+down,ctrl-a:toggle-all",
      // GitHub Desktop style: everything checked by default. Must be the
      // `load` event, not `start`: start fires before the piped input is
      // read, so select-all would apply to an empty list and enter/ctrl-d
      // would act on only the focused file.
      "--bind=load:select-all",
      "--expect=ctrl-d",        // detect discard key; printed as first output line
      // Preview pane: right side, 60% width
      `--preview=${previewCmd}`,
      "--preview-window=right:60%:wrap:border-left",
      "--preview-label= diff ",
      // Highlight matched characters
      `--color=hl:#ffb86c,hl+:#ffb86c,border:${toHex(T.pink)}`,
    ],
    {
      input,
      stdio: ["pipe", "pipe", "inherit"],
      encoding: "utf8",
      cwd,
    },
  );

  cleanupPreview();

  // fzf exits non-zero on ESC / Ctrl+C
  if (result.status !== 0 || !result.stdout?.trim()) {
    return null;
  }

  // With --expect, fzf prints the exit key on the first line (empty string for
  // enter). Only strip the trailing newline — a full trim() would eat the empty
  // key line and shift the first selected file into the exitKey slot.
  const lines = result.stdout.replace(/\n$/, "").split("\n");
  const exitKey = lines[0] ?? "";

  const paths = lines
    .slice(1)
    .map((line) => {
      const value = line.split("\t")[0]!; // "<xy>:<path>"
      return value.slice(value.indexOf(":") + 1); // "<path>"
    })
    .filter(Boolean);

  return { exitKey, paths };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function commitFlow(_args: string[], ctx: CommandContext): Promise<void> {
  const cwd = ctx.identity!.repoRoot;

  // Loop: discard returns to the picker with a refreshed file list.
  // This mirrors GitHub Desktop — after discarding, the changes list updates in-place.
  while (true) {
    const files = getChangedFiles(cwd);
    if (files.length === 0) {
      process.stderr.write("\n  \x1b[2mnothing to commit — working tree clean\x1b[0m\n\n");
      process.exit(0);
    }

    const result = runFilePicker(cwd, files);

    if (!result) {
      process.stderr.write("\n  \x1b[2maborted\x1b[0m\n\n");
      process.exit(0);
    }

    if (result.exitKey === "ctrl-d") {
      if (result.paths.length === 0) {
        process.stderr.write("\n  \x1b[33mno files selected — nothing to discard\x1b[0m\n\n");
        continue;
      }

      const confirmed = await confirmDiscard(result.paths);
      if (!confirmed) {
        process.stderr.write("  \x1b[2mcancelled\x1b[0m\n\n");
        continue;
      }

      try {
        discardChanges(cwd, files, result.paths);
      } catch (err) {
        process.stderr.write(`  \x1b[31mdiscard failed:\x1b[0m ${errMessage(err)}\n`);
        continue;
      }
      const label = result.paths.length === 1 ? result.paths[0] : `${result.paths.length} files`;
      process.stderr.write(`  \x1b[32mdiscarded\x1b[0m ${label}\n`);
      // Loop back — next iteration rebuilds the file list from fresh git status
      continue;
    }

    if (result.paths.length === 0) {
      process.stderr.write("\n  \x1b[33mno files selected — nothing to commit\x1b[0m\n\n");
      process.exit(0);
    }

    try {
      syncStagingArea(cwd, files, new Set(result.paths));
    } catch (err) {
      process.stderr.write(`\n  \x1b[31mstaging failed:\x1b[0m ${errMessage(err)}\n\n`);
      process.exit(1);
    }

    const stagedList = result.paths.map((p) => `  \x1b[32m+\x1b[0m ${p}`).join("\n");
    process.stderr.write(`\n${stagedList}\n\n`);

    const { textInput } = await import("../lib/rt-render.tsx");
    const message = await textInput({
      message: "Commit message",
      placeholder: "feat: ...",
    });

    if (!message.trim()) {
      // The staging changes from syncStagingArea are left in place (index now
      // matches the selection), so a plain `git commit` can pick up from here.
      process.stderr.write("\n  \x1b[33mempty message — commit aborted\x1b[0m\n\n");
      process.exit(0);
    }

    try {
      const summary = commitStaged(cwd, message.trim());
      process.stderr.write(`\n  \x1b[32m✔\x1b[0m ${summary}\n\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`\n  \x1b[31mcommit failed:\x1b[0m ${errMessage(err)}\n\n`);
      process.exit(1);
    }
  }
}
