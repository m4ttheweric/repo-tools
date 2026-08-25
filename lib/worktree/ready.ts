/**
 * Ready-step engine: which steps a worktree freshen needs to run, and
 * running them.
 *
 * "changed" steps only fire when their glob matches a path that actually
 * changed since the worktree's last ready stamp; a null changed set (stamp
 * unknown to git, e.g. cold create) means run everything.
 */

import { runGit } from "./git-async.ts";
import { runCapture } from "../subprocess.ts";
import type { ReadyStep } from "./config.ts";

/**
 * Paths changed between readyStamp and HEAD, or null when readyStamp is
 * unknown to git (treat as "everything changed").
 */
export async function changedSince(worktreePath: string, readyStamp: string): Promise<string[] | null> {
  const r = await runGit(worktreePath, ["diff", "--name-only", `${readyStamp}..HEAD`]);
  if (r.exitCode !== 0) return null;
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const CHANGED_WHEN_RE = /^changed:(.+)$/;

/**
 * changed === null → every step (cold create / unknown stamp). Otherwise:
 * steps whose `when` is "changed:<glob>" and the glob matches some changed
 * path; steps with no `when` are skipped.
 */
export function stepsToRun(steps: ReadyStep[], changed: string[] | null): ReadyStep[] {
  if (changed === null) return steps;

  return steps.filter((step) => {
    if (!step.when) return false;
    const match = CHANGED_WHEN_RE.exec(step.when);
    if (!match) return false;
    const glob = new Bun.Glob(match[1]!);
    return changed.some((path) => glob.match(path));
  });
}

/**
 * A minimal seed so the (absolute-path) login shell can start; its own
 * startup then rebuilds the full PATH for `worktreePath`. Inheriting the
 * daemon's boot-time PATH instead would replay a snapshot resolved in the
 * daemon's directory, whose entries shadow any directory-scoped toolchain
 * (version managers, direnv, project-local bins) that a step needs in-tree.
 */
const SEED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** Run ready steps in order via zsh, stopping at the first failure. */
export async function runReadySteps(
  worktreePath: string,
  steps: ReadyStep[],
): Promise<{ ok: true } | { ok: false; failedStep: string; output: string }> {
  for (const step of steps) {
    const r = await runCapture(["/bin/zsh", "-lc", step.run], {
      cwd: worktreePath,
      env: { ...process.env, PATH: SEED_PATH },
      timeoutMs: 15 * 60_000,
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      let output = r.stdout + r.stderr;
      // 127 under a daemon is nearly always a PATH mystery — name the shell
      // contract so the failure is actionable instead of a silent backoff loop.
      if (r.exitCode === 127 || /command not found/.test(output)) {
        output += "\n(ready steps run under `zsh -lc`: ~/.zshenv and ~/.zprofile are sourced, ~/.zshrc is NOT — put PATH setup for this tool in one of the former)";
      }
      return { ok: false, failedStep: step.run, output };
    }
  }
  return { ok: true };
}
