/**
 * rt commit — Interactive GitHub Desktop-style staging + commit flow.
 *
 * Presents an fzf multi-picker of all changed files (staged + unstaged).
 * Files already staged are pre-selected (checked). The right-side fzf
 * preview pane shows a live diff for the focused file, rendered via delta
 * (with fallback to plain `git diff --color=always` if delta is not installed).
 *
 * Flow:
 *   1. Parse `git status --porcelain` → build file list
 *   2. fzf multi-picker with diff preview on the right (60% width)
 *   3. Sync the staging area: add newly-selected, unstage deselected
 *   4. Prompt for commit message
 *   5. Run `git commit -m "…"`
 *   6. Print the resulting short SHA
 */

import { execSync, spawnSync } from "child_process";
import type { CommandContext } from "../lib/command-tree.ts";
import { textInput } from "../lib/rt-render.tsx";

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

// ─── delta / diff detection ───────────────────────────────────────────────────

/** Returns the diff command to pipe into for colorised output.
 *  Uses delta if available, otherwise falls back to nothing (git produces ANSI itself). */
function deltaPipeCmd(): string {
  try {
    execSync("which delta", { stdio: "pipe" });
    // delta flags tuned for preview pane:
    //   --no-gitconfig       ignore user's ~/.gitconfig pager settings
    //   --paging=never       never launch a sub-pager inside fzf
    //   --width=variable     fit to preview pane width
    //   --line-numbers       show line numbers
    //   --syntax-theme=...   dark theme that works well on most terminals
    return "| delta --no-gitconfig --paging=never --width=variable --line-numbers --syntax-theme=\"Monokai Extended\"";
  } catch {
    return "";
  }
}

/**
 * Build the preview command passed to fzf's --preview flag.
 *
 * Uses `bash -c '...' -- {1}` so that:
 *   - The script uses proper multi-line if/then/else (no "then;" or "else;"
 *     which are illegal in zsh and cause the parse error).
 *   - fzf substitutes {1} as a shell argument ($1), so paths with spaces
 *     are handled correctly.
 *
 * The fzf value column is: "<rawStatus>:<path>"
 * We parse $1 to choose the right git diff command:
 *   - Untracked (??)      → git diff --no-index /dev/null <file>
 *   - Staged only         → git diff --cached -- <file>
 *   - Staged + unstaged   → show both sections with headers
 *   - Unstaged only       → git diff -- <file>
 */
function buildPreviewCmd(cwd: string, pipe: string): string {
  // Build the script with real newlines — no semicolons after then/else.
  // $1 is the fzf value field passed via `-- {1}`.
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

  // Pass the script to bash -c with {1} as positional arg $1.
  // JSON.stringify produces a double-quoted string safe to embed in shell.
  return `bash -c ${JSON.stringify(script)} -- {1}`;
}

// ─── fzf picker ───────────────────────────────────────────────────────────────

/**
 * Show fzf multi-picker with live diff preview.
 * Returns the set of selected file paths, or null if the user cancelled.
 */
function runFilePicker(
  cwd: string,
  files: ChangedFile[],
  initiallyStaged: Set<string>,
): string[] | null {
  const pipe = deltaPipeCmd();
  const previewCmd = buildPreviewCmd(cwd, pipe);

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
      "--header=space: stage/unstage  tab: toggle+next  enter: commit  esc: abort",
      "--no-mouse",
      "--bind=space:toggle,tab:toggle+down",
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
    return null;
  }

  // Extract the path from the value column "<xy>:<path>"
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const value = line.split("\t")[0]!; // "<xy>:<path>"
      return value.slice(value.indexOf(":") + 1); // "<path>"
    })
    .filter(Boolean);
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

  // 1. Get all changed files
  const files = getChangedFiles(cwd);
  if (files.length === 0) {
    process.stderr.write("\n  \x1b[2mnothing to commit — working tree clean\x1b[0m\n\n");
    process.exit(0);
  }

  const initiallyStaged = new Set(files.filter((f) => f.isStaged).map((f) => f.path));

  // 2. Show fzf file picker with diff preview
  const selected = runFilePicker(cwd, files, initiallyStaged);

  if (!selected) {
    process.stderr.write("\n  \x1b[2maborted\x1b[0m\n\n");
    process.exit(0);
  }

  if (selected.length === 0) {
    process.stderr.write("\n  \x1b[33mno files selected — nothing to commit\x1b[0m\n\n");
    process.exit(0);
  }

  // 3. Sync the staging area
  const selectedSet = new Set(selected);
  syncStagingArea(cwd, files, selectedSet, initiallyStaged);

  // 4. Show what's staged now
  const stagedList = selected.map((p) => `  \x1b[32m+\x1b[0m ${p}`).join("\n");
  process.stderr.write(`\n${stagedList}\n\n`);

  // 5. Prompt for commit message
  const message = await textInput({
    message: "Commit message",
    placeholder: "feat: ...",
  });

  if (!message.trim()) {
    // User submitted empty message — unstage everything we just staged and abort
    process.stderr.write("\n  \x1b[33mempty message — commit aborted\x1b[0m\n\n");
    process.exit(0);
  }

  // 6. Commit
  try {
    const output = execSync(`git commit -m ${JSON.stringify(message.trim())}`, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });

    // Extract the short SHA from the first line of output (e.g. "[main a1b2c3d] feat: ...")
    const firstLine = output.split("\n")[0] ?? "";
    process.stderr.write(`\n  \x1b[32m✔\x1b[0m ${firstLine}\n\n`);
  } catch (err: unknown) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as NodeJS.ErrnoException & { stderr: string }).stderr) : String(err);
    process.stderr.write(`\n  \x1b[31mcommit failed:\x1b[0m ${stderr}\n\n`);
    process.exit(1);
  }
}
