/**
 * Pure logic for `rt worktree each` — arg parsing, target selection, name
 * formatting, and result summary. No IO: everything here is deterministic and
 * unit-tested. The command module (commands/worktree.ts) supplies the real
 * worktree list, picker, and process execution.
 */

import type { WorktreeBinding } from "./daemon/parking-lot.ts";

export type SelectionMode = "all" | "parked" | "pick";

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
 * Split raw CLI args into a selection mode and the command string. `--all` and
 * `--parked` are recognized anywhere in the args; every other token is part of
 * the command, joined with spaces. Neither flag → interactive pick mode.
 */
export function parseEachArgs(args: string[]): ParsedEachArgs {
  const all    = args.includes("--all");
  const parked = args.includes("--parked");
  if (all && parked) {
    return { mode: "all", command: "", error: "--all and --parked are mutually exclusive" };
  }
  const mode: SelectionMode = all ? "all" : parked ? "parked" : "pick";
  const command = args.filter(a => a !== "--all" && a !== "--parked").join(" ").trim();
  if (!command) {
    return { mode, command: "", error: "no command given — usage: rt worktree each '<command>'" };
  }
  return { mode, command };
}

/** A worktree is parked when it sits on its own parking-lot/<index> slot. */
export function isParked(b: WorktreeBinding): boolean {
  return b.index > 0 && b.branch === `parking-lot/${b.index}`;
}

/**
 * Resolve the target bindings for a non-interactive mode. "pick" is returned
 * unchanged — the caller runs the picker over the full list.
 */
export function filterTargets(bindings: WorktreeBinding[], mode: SelectionMode): WorktreeBinding[] {
  if (mode === "parked") return bindings.filter(isParked);
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
