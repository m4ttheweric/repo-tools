/**
 * Non-interactive git primitives behind `rt commit`: change listing, discard,
 * staging sync, and commit. Kept free of fzf/prompt concerns so they are unit
 * testable against real repos.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

export interface ChangedFile {
  /** Raw two-char porcelain status (e.g. "M ", " M", "??", "A ", "R ") */
  rawStatus: string;
  /** Relative path from repo root (rename target for renames) */
  path: string;
  /** Rename/copy source path; needed to fully unstage or revert a rename */
  origPath?: string;
  /** True if the index (left) column indicates a staged change */
  isStaged: boolean;
  /** True if the worktree (right) column indicates an unstaged change */
  hasUnstaged: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

/**
 * List all changed files via `git status --porcelain -z`. NUL termination is
 * required for correctness: without -z git C-quotes paths containing unicode
 * or special characters, and rename records use an ambiguous " -> " separator.
 */
export function getChangedFiles(cwd: string, paths?: string[]): ChangedFile[] {
  let out: string;
  try {
    out = git(cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      ...(paths && paths.length > 0 ? ["--", ...paths] : []),
    ]);
  } catch {
    return [];
  }

  const tokens = out.split("\0");
  const files: ChangedFile[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length < 4) continue;

    const xy = token.slice(0, 2);
    const path = token.slice(3);
    // In -z format a rename/copy record is followed by the source path as its
    // own NUL-terminated field.
    const origPath = xy[0] === "R" || xy[0] === "C" ? tokens[++i] : undefined;

    const isUntracked = xy === "??";
    files.push({
      rawStatus: xy,
      path,
      origPath,
      isStaged: !isUntracked && xy[0] !== " " && xy[0] !== "?",
      hasUnstaged: isUntracked || xy[1] !== " ",
    });
  }

  return files;
}

/**
 * Discard all changes (staged + unstaged) to the selected paths, restoring
 * HEAD state. `git checkout HEAD -- <paths>` alone cannot do this: it rejects
 * any path unknown to HEAD (staged-new files, rename targets), and one bad
 * path fails the whole batch. So: unstage first, re-stat, then restore what
 * HEAD knows and delete what it does not.
 */
export function discardChanges(
  cwd: string,
  files: ChangedFile[],
  selectedPaths: string[],
): void {
  const selectedSet = new Set(selectedPaths);
  const selected = files.filter((f) => selectedSet.has(f.path));

  const toUnstage = selected
    .filter((f) => f.isStaged)
    .flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  if (toUnstage.length > 0) {
    git(cwd, ["reset", "-q", "HEAD", "--", ...toUnstage]);
  }

  const statPaths = [
    ...new Set(selected.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]))),
  ];
  const remaining = getChangedFiles(cwd, statPaths);

  const toCheckout = remaining.filter((f) => f.rawStatus !== "??").map((f) => f.path);
  const toDelete = remaining.filter((f) => f.rawStatus === "??").map((f) => f.path);

  if (toCheckout.length > 0) {
    git(cwd, ["checkout", "HEAD", "--", ...toCheckout]);
  }
  for (const p of toDelete) {
    rmSync(join(cwd, p), { recursive: true, force: true });
  }
}

/**
 * Bring the git index into sync with the user's selection.
 *   - Selected files with content not yet in the index → git add (partially
 *     staged files are re-added so the full file content is committed)
 *   - Deselected files with staged changes → unstage (both sides of a rename)
 * Untracked deselected files are left alone; `git restore --staged` would
 * reject them.
 */
export function syncStagingArea(
  cwd: string,
  files: ChangedFile[],
  selectedPaths: Set<string>,
): void {
  const toAdd: string[] = [];
  const toUnstage: string[] = [];

  for (const f of files) {
    if (selectedPaths.has(f.path)) {
      if (!f.isStaged || f.hasUnstaged) toAdd.push(f.path);
    } else if (f.isStaged) {
      toUnstage.push(f.path);
      if (f.origPath) toUnstage.push(f.origPath);
    }
  }

  if (toAdd.length > 0) {
    git(cwd, ["add", "--", ...toAdd]);
  }
  if (toUnstage.length > 0) {
    git(cwd, ["reset", "-q", "HEAD", "--", ...toUnstage]);
  }
}

/**
 * Commit the staged changes. The message is passed as an argv element (never
 * through a shell), so quotes, newlines, and `$(...)` are committed verbatim.
 * Returns git's summary line (e.g. "[main a1b2c3d] feat: ...").
 */
export function commitStaged(cwd: string, message: string): string {
  const out = git(cwd, ["commit", "-m", message]);
  return out.split("\n")[0] ?? "";
}
