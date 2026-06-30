/**
 * rt commit — GitHub Desktop-style staging, discarding, and commit flow.
 *
 * Presents an fzf multi-picker of all changed files (staged + unstaged).
 * Files already staged are pre-selected (checked). The right-side fzf
 * preview pane shows a live diff for the focused file, rendered via delta
 * (with fallback to plain `git diff --color=always` if delta is not installed).
 *
 * Operations (mirrors GitHub Desktop's Changes tab exactly):
 *   - space: stage/unstage (toggle inclusion in commit)
 *   - ctrl-d: discard working-tree changes for selected files
 *   - enter: commit staged selection
 *   - esc: abort
 *
 * Discard uses `git checkout HEAD -- <paths>` — the same command GitHub Desktop
 * runs (see app/src/lib/git/checkout.ts:checkoutPaths in desktop/desktop).
 *
 * Flow:
 *   1. Parse `git status --porcelain` → build file list
 *   2. fzf multi-picker with diff preview on the right (60% width)
 *   3a. ctrl-d → confirm → `git checkout HEAD -- <paths>` → back to step 1
 *   3b. enter → sync staging area → commit message → `git commit` → done
 *   3c. esc → abort
 */

import { execSync, spawnSync } from "child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CommandContext } from "../lib/command-tree.ts";
import { textInput } from "../lib/rt-render.tsx";
import { ensureFzf } from "../lib/fzf.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChangedFile {
  /** Raw two-char porcelain status (e.g. "M ", " M", "??", "A ", "D ") */
  rawStatus: string;
  /** Relative path from repo root */
  path: string;
  /** True if the index (left) column indicates a staged change */
  isStaged: boolean;
  /** True if the worktree (right) column indicates an unstaged change */
  hasUnstaged: boolean;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function getChangedFiles(cwd: string): ChangedFile[] {
  let out: string;
  try {
    out = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: "pipe" });
  } catch {
    return [];
  }

  const files: ChangedFile[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;

    // Porcelain v1: XY PATH  (or XY PATH -> NEWPATH for renames)
    const xy = line.slice(0, 2);
    let path = line.slice(3).trim();

    // Handle renames: "R  old -> new" → take the "new" path
    if (path.includes(" -> ")) {
      path = path.split(" -> ")[1]!.trim();
    }

    const indexStatus = xy[0]!;   // left column  = staged
    const wtreeStatus = xy[1]!;   // right column = unstaged

    const isUntracked = xy === "??";

    files.push({
      rawStatus: xy,
      path,
      isStaged: !isUntracked && indexStatus !== " " && indexStatus !== "?",
      hasUnstaged: isUntracked || wtreeStatus !== " ",
    });
  }

  return files;
}

/** Build a human-readable status badge and icon */
function fileLabel(f: ChangedFile): string {
  const ICONS: Record<string, string> = {
    "??": "  \x1b[2m??\x1b[0m",  // untracked
    "A ": "  \x1b[32mA \x1b[0m",  // new staged
    "M ": "  \x1b[33mM \x1b[0m",  // modified staged
    "D ": "  \x1b[31mD \x1b[0m",  // deleted staged
    "R ": "  \x1b[34mR \x1b[0m",  // renamed staged
    " M": "  \x1b[2mM \x1b[0m",   // modified unstaged only
    " D": "  \x1b[2mD \x1b[0m",   // deleted unstaged only
    MM:   "  \x1b[33mMM\x1b[0m",  // staged + unstaged mods
  };
  const icon = ICONS[f.rawStatus] ?? `  ${f.rawStatus}`;
  return `${icon}  ${f.path}`;
}

/** Discard working-tree changes via `git checkout HEAD -- <paths>`.
 *  This is the exact command GitHub Desktop uses
 *  (app/src/lib/git/checkout.ts:checkoutPaths). */
function discardWorkingTreeChanges(cwd: string, paths: string[]): void {
  execSync(
    `git checkout HEAD -- ${paths.map((p) => JSON.stringify(p)).join(" ")}`,
    { cwd, stdio: "pipe" },
  );
}

/** Inline confirmation before discarding. Mirrors GitHub Desktop's
 *  DiscardChanges dialog — always confirms, never discards silently. */
async function confirmDiscard(paths: string[]): Promise<boolean> {
  const label =
    paths.length === 1 ? `"${paths[0]}"` : `${paths.length} files`;
  process.stderr.write(`\n  discard changes to ${label}? [y/N] `);

  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question("", (answer) => {
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
  try {
    execSync("which delta", { stdio: "pipe" });
    // delta flags tuned for the preview pane.
    // --syntax-theme intentionally omitted — let delta use its configured default
    // to avoid quote-escaping issues when the theme name contains spaces.
    return "| delta --no-gitconfig --paging=never --width=variable --line-numbers";
  } catch {
    return "";
  }
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
function runFilePicker(
  cwd: string,
  files: ChangedFile[],
  initiallyStaged: Set<string>,
): PickerResult | null {
  ensureFzf();
  const pipe = deltaPipeCmd();
  const { cmd: previewCmd, cleanup: cleanupPreview } = buildPreviewCmd(cwd, pipe);

  // Build the input: "<xy>:<path>\t<displayLabel>"
  const input = files
    .map((f) => `${f.rawStatus}:${f.path}\t${fileLabel(f)}`)
    .join("\n");

  // Pre-select already-staged files using fzf's start binding.
  // Strategy: toggle-all (select all), then individually deselect unstaged-only files.
  const stagedIndices: number[] = [];
  files.forEach((f, i) => {
    if (initiallyStaged.has(f.path)) stagedIndices.push(i + 1); // 1-indexed
  });

  let startBinding = "";
  if (stagedIndices.length > 0) {
    // toggle-all selects everything, then deselect items that should NOT be staged
    const deselect = files
      .map((f, i) => (initiallyStaged.has(f.path) ? null : `pos(${i + 1})+deselect`))
      .filter(Boolean);
    const actions = ["select-all", ...deselect, "pos(1)"].join("+");
    startBinding = `--bind=start:${actions}`;
  }

  const result = spawnSync(
    "fzf",
    [
      "--multi",
      "--ansi",
      "--with-nth=2..",         // display label col; value col is hidden
      "--delimiter=\t",
      "--layout=reverse",
      "--border=rounded",
      "--border-label= rt commit ",
      "--prompt=  filter: ",
      "--header=space: stage  tab: toggle+next  ctrl-a: toggle-all  ctrl-d: discard  enter: commit  esc: abort",
      "--no-mouse",
      "--bind=space:toggle,tab:toggle+down,ctrl-a:toggle-all",
      "--expect=ctrl-d",        // detect discard key; printed as first output line
      // Preview pane: right side, 60% width
      `--preview=${previewCmd}`,
      "--preview-window=right:60%:wrap:border-left",
      "--preview-label= diff ",
      // Highlight matched characters
      "--color=hl:#ffb86c,hl+:#ffb86c",
      // Only add start binding if we have staged files to pre-select
      ...(startBinding ? [startBinding] : []),
    ],
    {
      input,
      stdio: ["pipe", "pipe", "inherit"],
      encoding: "utf8",
      cwd,
    },
  );

  // fzf exits non-zero on ESC / Ctrl+C
  if (result.status !== 0 || !result.stdout?.trim()) {
    cleanupPreview();
    return null;
  }

  cleanupPreview();

  // With --expect, fzf prints the exit key on the first line (empty string for enter).
  // Subsequent lines are the selected items: "<xy>:<path>\t<label>"
  const lines = result.stdout.trim().split("\n");
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

// ─── Staging sync ─────────────────────────────────────────────────────────────

/**
 * Bring the git index into sync with the user's selection.
 *   - Files selected but not yet staged → git add
 *   - Files that were staged but deselected → git restore --staged
 *   - Untracked files selected → git add (stages new file)
 */
function syncStagingArea(
  cwd: string,
  allFiles: ChangedFile[],
  selectedPaths: Set<string>,
  previouslyStaged: Set<string>,
): void {
  const toAdd: string[] = [];
  const toUnstage: string[] = [];

  for (const f of allFiles) {
    if (selectedPaths.has(f.path) && !f.isStaged) {
      toAdd.push(f.path);
    } else if (!selectedPaths.has(f.path) && previouslyStaged.has(f.path)) {
      toUnstage.push(f.path);
    }
  }

  if (toAdd.length > 0) {
    execSync(`git add -- ${toAdd.map((p) => JSON.stringify(p)).join(" ")}`, {
      cwd,
      stdio: "pipe",
    });
  }

  if (toUnstage.length > 0) {
    execSync(
      `git restore --staged -- ${toUnstage.map((p) => JSON.stringify(p)).join(" ")}`,
      { cwd, stdio: "pipe" },
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function commitFlow(_args: string[], ctx: CommandContext): Promise<void> {
  const cwd = ctx.identity!.repoRoot;

  // Loop: discard returns to the picker with a refreshed file list.
  // This mirrors GitHub Desktop — after discarding, the changes list updates in-place.
  while (true) {
    // 1. Get all changed files
    const files = getChangedFiles(cwd);
    if (files.length === 0) {
      process.stderr.write("\n  \x1b[2mnothing to commit — working tree clean\x1b[0m\n\n");
      process.exit(0);
    }

    // GitHub Desktop style: all files selected by default — deselect what you don't want
    const initiallyStaged = new Set(files.map((f) => f.path));

    // 2. Show fzf file picker with diff preview
    const result = runFilePicker(cwd, files, initiallyStaged);

    if (!result) {
      process.stderr.write("\n  \x1b[2maborted\x1b[0m\n\n");
      process.exit(0);
    }

    // 3a. ctrl-d — discard working-tree changes (GH Desktop: checkoutPaths → checkout HEAD)
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

      discardWorkingTreeChanges(cwd, result.paths);
      const label = result.paths.length === 1 ? result.paths[0] : `${result.paths.length} files`;
      process.stderr.write(`  \x1b[32mdiscarded\x1b[0m ${label}\n`);
      // Loop back — next iteration rebuilds the file list from fresh git status
      continue;
    }

    // 3b. enter — proceed with commit
    if (result.paths.length === 0) {
      process.stderr.write("\n  \x1b[33mno files selected — nothing to commit\x1b[0m\n\n");
      process.exit(0);
    }

    // 4. Sync the staging area to match selection
    const selectedSet = new Set(result.paths);
    syncStagingArea(cwd, files, selectedSet, initiallyStaged);

    // 5. Show what's staged now
    const stagedList = result.paths.map((p) => `  \x1b[32m+\x1b[0m ${p}`).join("\n");
    process.stderr.write(`\n${stagedList}\n\n`);

    // 6. Prompt for commit message
    const message = await textInput({
      message: "Commit message",
      placeholder: "feat: ...",
    });

    if (!message.trim()) {
      // User submitted empty message — unstage everything we just staged and abort
      process.stderr.write("\n  \x1b[33mempty message — commit aborted\x1b[0m\n\n");
      process.exit(0);
    }

    // 7. Commit
    try {
      const output = execSync(`git commit -m ${JSON.stringify(message.trim())}`, {
        cwd,
        encoding: "utf8",
        stdio: "pipe",
      });

      // Extract the short SHA from the first line of output (e.g. "[main a1b2c3d] feat: ...")
      const firstLine = output.split("\n")[0] ?? "";
      process.stderr.write(`\n  \x1b[32m✔\x1b[0m ${firstLine}\n\n`);
      process.exit(0);
    } catch (err: unknown) {
      const stderr =
        err instanceof Error && "stderr" in err ? String((err as NodeJS.ErrnoException & { stderr: string }).stderr) : String(err);
      process.stderr.write(`\n  \x1b[31mcommit failed:\x1b[0m ${stderr}\n\n`);
      process.exit(1);
    }
  }
}
