/**
 * rt rebase escalation ... conflict bundle, agent task, and verification.
 *
 * When rebaseOnto() pauses on unresolvable conflicts (onConflict: "pause"),
 * this module turns the paused state into:
 *   - a deterministic ConflictBundle (JSON contract for agent callers, exit 3)
 *   - an agent task prompt (resolved via a Claude pane in herdr)
 *   - a human report (manual resolution path)
 * and verifies the outcome from git state only (never agent output).
 */

import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { RebaseResult } from "../commands/git/rebase.ts";
import { getCurrentBranch, hasUncommittedChanges } from "./git-ops.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConflictBundle {
  kind: "rebase-conflict";
  state: "mid-rebase" | "aborted";
  branch: string;
  target: string;
  commitsBehind: number;
  unresolvedFiles: string[];
  autoResolvedFiles: string[];
  backupBranch: string | null;
  branchCommits: string[];
  targetCommits: string[];
  hint: string;
}

export type RebaseVerdict =
  | "completed"
  | "agent-aborted"
  | "still-in-progress"
  | "dirty"
  | "wrong-branch";

const COMMIT_CAP = 20;

// ─── Git helpers ─────────────────────────────────────────────────────────────

function gitLines(args: string[], cwd: string): string[] {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (r.status !== 0) return [];
  return (r.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
}

function gitOk(args: string[], cwd: string): boolean {
  return spawnSync("git", args, { cwd, stdio: "pipe" }).status === 0;
}

// ─── Bundle ──────────────────────────────────────────────────────────────────

export function buildConflictBundle(result: RebaseResult, cwd: string): ConflictBundle {
  // Mid-rebase HEAD is detached partway through replay, so commit lists MUST
  // come from the branch ref (unchanged until the rebase completes).
  const mergeBase = gitLines(["merge-base", result.branch, result.target], cwd)[0] ?? "";
  const branchCommits = mergeBase
    ? gitLines(["log", "--oneline", `-${COMMIT_CAP}`, `${mergeBase}..${result.branch}`], cwd)
    : [];
  const targetCommits = mergeBase
    ? gitLines(["log", "--oneline", `-${COMMIT_CAP}`, `${mergeBase}..${result.target}`], cwd)
    : [];

  return {
    kind: "rebase-conflict",
    state: result.rebaseInProgress ? "mid-rebase" : "aborted",
    branch: result.branch,
    target: result.target,
    commitsBehind: result.commitsBehind,
    unresolvedFiles: result.unresolvedFiles,
    autoResolvedFiles: result.resolvedFiles,
    backupBranch: result.backupBranch,
    branchCommits,
    targetCommits,
    hint: "resolve conflicts, git add, git rebase --continue; or git rebase --abort",
  };
}

// ─── Renderers ───────────────────────────────────────────────────────────────

export function renderAgentTask(bundle: ConflictBundle, cwd: string): string {
  const files = bundle.unresolvedFiles.map((f) => `- ${f}`).join("\n");
  const branchLog = bundle.branchCommits.map((c) => `- ${c}`).join("\n") || "- (none)";
  const targetLog = bundle.targetCommits.map((c) => `- ${c}`).join("\n") || "- (none)";

  return `# Task: resolve a paused rebase

You are in \`${cwd}\`. A rebase of \`${bundle.branch}\` onto \`${bundle.target}\` is paused mid-conflict.

Conflicted files:
${files}

The branch's intent (its commit subjects):
${branchLog}

Incoming from ${bundle.target}:
${targetLog}

Instructions:
1. Resolve each conflicted file semantically so both intents survive.
2. \`git add\` the resolved files, then run \`git rebase --continue\`.
3. Later commits may conflict again; resolve those the same way until the rebase completes.
4. Do NOT push. Do NOT modify unrelated files.
5. If you cannot resolve a conflict confidently, run \`git rebase --abort\` and explain why.

A backup of the pre-rebase branch exists at \`${bundle.backupBranch ?? "(none)"}\`.
`;
}

export function renderHumanReport(bundle: ConflictBundle): string {
  const files = bundle.unresolvedFiles.map((f) => `    • ${f}`).join("\n");
  const lines = [
    ``,
    `  rebase of ${bundle.branch} onto ${bundle.target} is paused with conflicts:`,
    files,
    ``,
    `  resolve manually, then:  git add <files> && git rebase --continue`,
    `  or give up:              git rebase --abort`,
  ];
  if (bundle.backupBranch) {
    lines.push(`  backup:                  ${bundle.backupBranch}`);
  }
  lines.push(`  rt did not push. after the rebase completes: git push --force-with-lease origin ${bundle.branch}`);
  lines.push(`  `);
  return lines.join("\n");
}

// ─── Task file ───────────────────────────────────────────────────────────────

export function writeTaskFile(dataDir: string, content: string): string {
  const dir = join(dataDir, "agent-tasks");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "");
  const path = join(dir, `rebase-${ts}.md`);
  writeFileSync(path, content);
  return path;
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Git-state-only verdict on what the agent left behind. Checked in order:
 * a still-running rebase, a dirty tree, a branch switch, and finally whether
 * the branch actually contains the target (the rebase really happened).
 */
export function verifyRebaseCompleted(cwd: string, branch: string, target: string): RebaseVerdict {
  if (gitOk(["rebase", "--show-current-patch"], cwd)) return "still-in-progress";
  if (hasUncommittedChanges(cwd)) return "dirty";
  if (getCurrentBranch(cwd) !== branch) return "wrong-branch";
  if (gitOk(["merge-base", "--is-ancestor", target, "HEAD"], cwd)) return "completed";
  return "agent-aborted";
}
