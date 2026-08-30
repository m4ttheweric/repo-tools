/**
 * Async git helpers for the worktree lifecycle.
 *
 * The daemon-safe replacement for the execSync-based git wrappers in
 * lib/git-ops.ts and lib/git-worktrees.ts: execSync blocks Bun's event loop
 * for the whole child lifetime, which on the daemon shows up as timed-out
 * status polls (see lib/subprocess.ts). Everything reachable from a daemon
 * timer or handler goes through here instead.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { runCapture } from "../subprocess.ts";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  /** True for the container-repo row a `bare` porcelain repo reports for
   *  itself (no working tree of its own) -- never a real, usable worktree. */
  isBare: boolean;
}

// rt drives git inside target repos but must never fire their hooks (repo
// stealth). A broken husky post-checkout/post-merge hook otherwise makes the
// checkout exit non-zero *after* it already succeeded, surfacing as a spurious
// "checkout-failed" even though the branch switched fine. Disable hooks on every
// mutating command by pointing hooksPath at a nonexistent dir.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

const DEFAULT_TIMEOUT_MS = 60_000;

/** Checkout/merge/stash on a large tree can legitimately exceed a minute; a
 *  60s SIGKILL leaves the working tree half-switched. Match fetch/worktree-add. */
export const MUTATING_TIMEOUT_MS = 5 * 60_000;

const DESKTOP_STASH_RE = /!!GitHub_Desktop<(.+)>$/;

/** Run a git command with hooks suppressed, capturing stdout+stderr. Never throws. */
export async function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<GitResult> {
  const argv: [string, ...string[]] = ["git", ...NO_HOOKS, ...args];
  const result = await runCapture(argv, {
    cwd,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stderr: "pipe",
  });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/** Run a git command and report only whether it succeeded (exitCode === 0). */
export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const r = await runGit(cwd, args);
  return r.exitCode === 0;
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranchAsync(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.exitCode !== 0) return null;
  const branch = r.stdout.trim();
  return branch.length > 0 ? branch : null;
}

export async function statusPorcelainAsync(cwd: string): Promise<string> {
  const r = await runGit(cwd, ["status", "--porcelain"], { timeoutMs: MUTATING_TIMEOUT_MS });
  return r.stdout;
}

export async function branchExistsLocalAsync(cwd: string, branch: string): Promise<boolean> {
  return gitOk(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/** Whether refs/remotes/origin/<branch> exists (i.e. was fetched). */
export async function remoteRefExists(cwd: string, branch: string): Promise<boolean> {
  return gitOk(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`]);
}

export async function isAncestorAsync(cwd: string, ancestor: string, tip: string): Promise<boolean> {
  return gitOk(cwd, ["merge-base", "--is-ancestor", ancestor, tip]);
}

/**
 * Resolve the repo's default remote ref. Ported from getRemoteDefaultBranch
 * (lib/git-ops.ts) rather than `symbolic-ref refs/remotes/origin/HEAD` — that
 * ref only exists after `git clone`/`remote set-head`, and fixtures built with
 * `remote add` + `fetch` never have it. Always returns; falls back to
 * "origin/master" when neither candidate resolves.
 */
export async function remoteDefaultRef(cwd: string): Promise<string> {
  for (const candidate of ["origin/main", "origin/master"]) {
    if (await gitOk(cwd, ["rev-parse", "--verify", candidate])) return candidate;
  }
  return "origin/master";
}

export async function headSha(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "HEAD"]);
  if (r.exitCode !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Enumerate worktrees for a repo via `git worktree list --porcelain`.
 * branch is null when a worktree is detached. Paths are filtered to those
 * that exist on disk (a worktree removed via `rm -rf` still shows up in
 * git's porcelain output, but it's not one we can operate on).
 *
 * Returns null on a nonzero exit (e.g. a broken or nonexistent git dir) so
 * callers can tell "git failed" apart from "git succeeded and reported no
 * worktrees" -- treating a failed listing as an empty one is how a registry
 * gets mass-pruned against a repo git briefly couldn't read.
 *
 * NOTE: returns git's canonicalized paths (/private/var/... on macOS
 * tmpdirs); callers comparing against stored paths rely on the
 * canonical-fixtures rule in Global Constraints.
 */
export async function listWorktreesAsync(repoPath: string): Promise<WorktreeEntry[] | null> {
  const r = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) return null;
  const results: WorktreeEntry[] = [];
  let curPath: string | null = null;
  let curBranch: string | null = null;
  let curBare = false;

  const flush = () => {
    if (curPath && existsSync(curPath)) {
      results.push({ path: curPath, branch: curBranch, isBare: curBare });
    }
  };

  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      curPath = line.slice("worktree ".length).trim();
      curBranch = null;
      curBare = false;
    } else if (line.startsWith("branch ")) {
      curBranch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      curBare = true;
    }
  }
  flush();

  return results;
}

/** Worktree root paths (main + linked), existing-on-disk only. `[]` on git
 *  failure ... the async twin of git-worktrees.ts listWorktreeRoots. */
export async function listWorktreeRootsAsync(repoPath: string): Promise<string[]> {
  return (await listWorktreesAsync(repoPath) ?? []).map((w) => w.path);
}

/**
 * Idempotently append `pattern` to the common git dir's info/exclude, with a
 * "# rt worktree" marker comment written on first use of this file. Returns
 * true when it wrote (pattern was missing), false when already present.
 */
export async function ensureInfoExclude(repoPath: string, pattern: string): Promise<boolean> {
  const r = await runGit(repoPath, ["rev-parse", "--git-common-dir"]);
  if (r.exitCode !== 0) return false;
  const commonDirRaw = r.stdout.trim();
  const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : join(repoPath, commonDirRaw);
  const excludePath = join(commonDir, "info", "exclude");

  mkdirSync(dirname(excludePath), { recursive: true });

  const content = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (content.split("\n").some((line) => line.trim() === pattern.trim())) {
    return false;
  }

  const prefix = content.length > 0 ? "\n" : "";
  const header = content.includes("# rt worktree") ? "" : "# rt worktree\n";
  appendFileSync(excludePath, `${prefix}${header}${pattern}\n`);
  return true;
}

/**
 * Stash uncommitted changes with a GitHub Desktop-compatible marker.
 * Async port of git-ops.ts stashChanges — interoperable with GitHub Desktop
 * and worktree-context.
 */
export async function stashChangesAsync(
  cwd: string,
  label: string,
  opts: { timeoutMs?: number } = {},
): Promise<GitResult> {
  const message = `!!GitHub_Desktop<${label}>`;
  return runGit(cwd, ["stash", "push", "-u", "-m", message], {
    timeoutMs: opts.timeoutMs ?? MUTATING_TIMEOUT_MS,
  });
}

export async function popStashAsync(
  cwd: string,
  stashName: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await runGit(cwd, ["stash", "pop", stashName], {
    timeoutMs: opts.timeoutMs ?? MUTATING_TIMEOUT_MS,
  });
}

/**
 * Find the most recent GitHub Desktop-tagged stash entry for a branch.
 * Async port of git-ops.ts findDesktopStash.
 */
export async function findDesktopStashAsync(cwd: string, branch: string): Promise<{ name: string } | null> {
  const r = await runGit(cwd, ["stash", "list"]);
  if (r.exitCode !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const match = DESKTOP_STASH_RE.exec(line);
    if (match && match[1] === branch) {
      const nameMatch = /^(stash@\{\d+\})/.exec(line);
      if (nameMatch) return { name: nameMatch[1]! };
    }
  }
  return null;
}
