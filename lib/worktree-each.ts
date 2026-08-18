/**
 * Pure logic for `rt worktree each` — arg parsing, target selection, name
 * formatting, and result summary. No IO: everything here is deterministic and
 * unit-tested. The command module (commands/worktree.ts) supplies the real
 * worktree list (sourced from the daemon's `worktree:list`, or the read-only
 * git fallback when the daemon is down), the picker, and process execution.
 */

export type SelectionMode = "all" | "on-deck" | "pick";

export interface ParsedEachArgs {
  mode: SelectionMode;
  /** The command to run in each worktree (flag tokens removed). */
  command: string;
  /** Set when the args are invalid; callers should print it and exit non-zero. */
  error?: string;
}

/** One worktree's outcome after running the command. code 0 == success. */
export interface EachResult {
  name: string;
  code: number;
  /** Present when the target could not be run at all (e.g. path vanished). */
  reason?: string;
}

/**
 * A worktree binding as `worktree each` needs it. `{path, branch}` always
 * comes from either the daemon's `worktree:list` (registry-aware — `state`
 * present) or the read-only git fallback (`lib/git-worktrees.ts`, no `state`)
 * used when the daemon is unreachable — `each` is the one lifecycle command
 * allowed that fallback, since it's read-only.
 */
export interface WorktreeBinding {
  path: string;
  branch: string | null;
  /** Registry state ("on-deck", "claimed", ...); absent from the git-only fallback. */
  state?: string;
}

/**
 * Split raw CLI args into a selection mode and the command string. `--all`
 * and `--on-deck` are recognized anywhere in the args; every other token is
 * part of the command, joined with spaces. `--parked` is a hidden alias for
 * `--on-deck`, kept for one release so muscle memory doesn't break mid-
 * migration off the old parking-lot terminology. Neither flag → interactive
 * pick mode.
 */
export function parseEachArgs(args: string[]): ParsedEachArgs {
  const all    = args.includes("--all");
  const onDeck = args.includes("--on-deck") || args.includes("--parked");
  if (all && onDeck) {
    return { mode: "all", command: "", error: "--all and --on-deck are mutually exclusive" };
  }
  const mode: SelectionMode = all ? "all" : onDeck ? "on-deck" : "pick";
  const command = args
    .filter((a) => a !== "--all" && a !== "--on-deck" && a !== "--parked")
    .join(" ")
    .trim();
  if (!command) {
    return { mode, command: "", error: "no command given — usage: rt worktree each '<command>'" };
  }
  return { mode, command };
}

/** A binding is on-deck when the registry says so (never true for the git-only fallback). */
export function isOnDeck(b: WorktreeBinding): boolean {
  return b.state === "on-deck";
}

/**
 * Resolve the target bindings for a non-interactive mode. "pick" is returned
 * unchanged — the caller runs the picker over the full list.
 */
export function filterTargets(bindings: WorktreeBinding[], mode: SelectionMode): WorktreeBinding[] {
  if (mode === "on-deck") return bindings.filter(isOnDeck);
  return bindings; // "all" and "pick" both start from the full list
}

/** Worktree path shown relative to the repo's parent dir, else the full path. */
export function relWorktreeName(repoPath: string, worktreePath: string): string {
  const repoDir = repoPath.replace(/\/[^/]+\/?$/, "");
  return worktreePath.startsWith(repoDir + "/")
    ? worktreePath.slice(repoDir.length + 1)
    : worktreePath;
}

/** One-line end summary: "N ok" plus failed names and their exit codes. */
export function formatSummary(results: EachResult[]): string {
  const ok     = results.filter(r => r.code === 0).length;
  const failed = results.filter(r => r.code !== 0);
  if (failed.length === 0) return `${ok} ok`;
  const detail = failed.map(r => `${r.name} (${r.reason ?? `exit ${r.code}`})`).join(", ");
  return `${ok} ok, ${failed.length} failed: ${detail}`;
}

export function hasFailures(results: EachResult[]): boolean {
  return results.some(r => r.code !== 0);
}
