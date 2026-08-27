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
import { buildPaneCommand } from "./agent-argv.ts";
import { defaultHerdrRunner, herdrAgentWait, launchInWorkspace, type HerdrRunner } from "./agent-herdr.ts";
import { getCurrentBranch, hasUncommittedChanges } from "./git-ops.ts";
import { syncLog } from "./sync-log.ts";
import { bold, cyan, dim, green, red, reset, yellow } from "./tui.ts";

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
const AGENT_WAIT_TIMEOUT_MS = 10 * 60_000;

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

// ─── Escalation flow ─────────────────────────────────────────────────────────

/**
 * Decide how (or whether) to escalate a paused rebase, from the raw argv and
 * whether we're attached to a TTY. --json always wins (agents pipe rt sync
 * and need a deterministic contract, not a prompt). Off-TTY without --json
 * preserves historic behavior: abort, exit 1, no prompt.
 */
export function resolveEscalationMode(args: string[], isTTY: boolean): "json" | "interactive" | "off" {
  if (args.includes("--json")) return "json";
  if (!isTTY || args.includes("--no-agent")) return "off";
  return "interactive";
}

function abortRebase(cwd: string): void {
  spawnSync("git", ["rebase", "--abort"], { cwd, stdio: "pipe" });
}

async function herdrAvailable(runner: HerdrRunner): Promise<boolean> {
  const r = await runner(["workspace", "list"]);
  return r.exitCode === 0;
}

/**
 * Turn a paused rebase into a resolution: JSON contract for agent callers,
 * or an interactive prompt (abort / hand to a herdr Claude pane / leave
 * paused for manual resolution). Returns the process exit code.
 */
export async function runEscalationFlow(opts: {
  cwd: string;
  dataDir: string;
  repoName: string;
  result: RebaseResult;
  mode: "interactive" | "json";
  autoYes: boolean;
  push: boolean;
  herdrRunner?: HerdrRunner;
}): Promise<number> {
  const { cwd, result } = opts;
  const bundle = buildConflictBundle(result, cwd);

  if (opts.mode === "json") {
    syncLog.phase("escalation", { mode: "json", files: bundle.unresolvedFiles });
    console.log(JSON.stringify(bundle, null, 2));
    return 3;
  }

  const runner: HerdrRunner = opts.herdrRunner ?? defaultHerdrRunner();
  const agentPossible = await herdrAvailable(runner);
  let choice: string;
  if (opts.autoYes && agentPossible) {
    choice = "agent";
  } else {
    if (opts.autoYes && !agentPossible) {
      // --agent asked to skip the prompt entirely, but there's no herdr to hand
      // off to... say so once instead of silently falling through to the prompt.
      console.log(`  ${yellow}--agent requested but herdr is not reachable... falling back to the prompt${reset}`);
    }
    const { select } = await import("./rt-render.tsx");
    const options = [
      { value: "abort", label: "abort the rebase", hint: "default, same as before" },
      ...(agentPossible
        ? [{ value: "agent", label: "resolve with a Claude agent in a herdr pane" }]
        : []),
      { value: "manual", label: "leave the rebase paused and resolve manually" },
    ];
    choice = await select({
      message: `${bundle.unresolvedFiles.length} conflict${bundle.unresolvedFiles.length !== 1 ? "s" : ""} need${bundle.unresolvedFiles.length !== 1 ? "" : "s"} resolution`,
      options,
    });
  }

  syncLog.phase("escalation", { mode: "interactive", choice, files: bundle.unresolvedFiles });

  if (choice === "abort") {
    abortRebase(cwd);
    if (bundle.backupBranch) {
      console.log(`  ${dim}rebase aborted; backup at ${bundle.backupBranch}${reset}`);
    }
    return 1;
  }

  if (choice === "manual") {
    console.log(renderHumanReport(bundle));
    return 1;
  }

  // choice === "agent"
  try {
    const taskPath = writeTaskFile(opts.dataDir, renderAgentTask(bundle, cwd));
    const sessionId = crypto.randomUUID();
    const paneCommand = buildPaneCommand(cwd, {
      session: { kind: "start", sessionId },
      headless: false,
      prompt: `Read ${taskPath} and complete the task it describes.`,
    });
    const out = await launchInWorkspace(
      { workspaceLabel: opts.repoName, tabLabel: `rebase ${bundle.branch}`, paneCommand },
      runner,
    );

    // An existing "rebase <branch>" tab was focused, not launched: there is no
    // fresh pane id to wait on (herdrAgentWait against "" would wait on nothing).
    if (out.focusedExisting) {
      syncLog.phase("escalation-agent", { focusedExisting: true, tab: out.tabId });
      console.log(
        `\n  ${yellow}herdr focused an existing agent tab${reset} ${dim}already working on ${bundle.branch}; nothing new was started.${reset}\n`,
      );
      return 1;
    }

    syncLog.phase("escalation-agent", { pane: out.paneId, taskPath });

    console.log(
      `\n  ${cyan}agent resolving conflicts in pane ${bold}${out.paneId}${reset}${cyan}…${reset} ${dim}(Ctrl+C to detach)${reset}`,
    );

    const onSigint = () => {
      console.log(
        `\n  ${yellow}detached${reset} ${dim}agent still working in pane ${out.paneId}.` +
          ` when it finishes: git push --force-with-lease origin ${bundle.branch}${reset}\n`,
      );
      process.exit(130);
    };
    process.on("SIGINT", onSigint);
    let settled: boolean;
    try {
      settled = await herdrAgentWait(out.paneId, ["idle", "done"], AGENT_WAIT_TIMEOUT_MS, runner);
    } finally {
      process.removeListener("SIGINT", onSigint);
    }

    if (!settled) {
      console.log(`\n  ${red}✗${reset} agent did not finish within 10 minutes; nothing was pushed`);
      console.log((await runner(["pane", "read", out.paneId, "--source", "recent"])).stdout);
      console.log(`  ${dim}pane ${out.paneId} is still open. backup: ${bundle.backupBranch}${reset}\n`);
      syncLog.phase("escalation-verdict", { verdict: "timeout" });
      return 1;
    }

    const verdict = verifyRebaseCompleted(cwd, bundle.branch, bundle.target);
    syncLog.phase("escalation-verdict", { verdict });

    if (verdict === "completed") {
      if (opts.push) {
        const pushRes = spawnSync(
          "git",
          ["push", "--force-with-lease", "origin", bundle.branch],
          { cwd, encoding: "utf8", stdio: "pipe" },
        );
        syncLog.cmd(`push --force-with-lease origin ${bundle.branch}`, cwd, pushRes.status ?? 1, pushRes.stdout ?? "", pushRes.stderr ?? "");
        if (pushRes.status !== 0) {
          console.log(`\n  ${red}✗ rebase completed but push failed:${reset} ${(pushRes.stderr ?? "").trim()}\n`);
          return 1;
        }
      }
      console.log(`\n  ${green}✓${reset} agent resolved the conflicts; ${bold}${bundle.branch}${reset} rebased${opts.push ? " and pushed" : ""}\n`);
      return 0;
    }

    if (verdict === "agent-aborted") {
      console.log(`\n  ${yellow}agent aborted the rebase.${reset} last pane output:\n`);
      console.log((await runner(["pane", "read", out.paneId, "--source", "recent"])).stdout);
      console.log(`  ${dim}backup: ${bundle.backupBranch}${reset}\n`);
      return 1;
    }

    console.log(`\n  ${red}✗ verification failed (${verdict}); nothing was pushed${reset}`);
    console.log((await runner(["pane", "read", out.paneId, "--source", "recent"])).stdout);
    console.log(`  ${dim}inspect pane ${out.paneId}. backup: ${bundle.backupBranch}${reset}\n`);
    return 1;
  } catch (err) {
    // Herdr tooling failed after the user chose escalation. Never abort their
    // paused rebase on a tooling failure; degrade to the manual ending.
    syncLog.phase("escalation-error", { error: String(err) });
    console.log(`\n  ${yellow}could not hand off to an agent (${err instanceof Error ? err.message : err})${reset}`);
    console.log(renderHumanReport(bundle));
    return 1;
  }
}
