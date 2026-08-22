/**
 * `rt home init`'s materialize phase — the last step of every init run.
 * Regenerates everything re-derivable from the declarative layer: rt's own
 * PATH shims and daemon registration, then each locally-installed tool's own
 * setup verb. Pure planning (`planMaterialize`) is separate from execution
 * (`runMaterialize`) so the decision of WHAT to run is unit-testable without
 * a real subprocess.
 *
 * Every step here must be non-destructive and idempotent — materialize runs
 * on EVERY `rt home init`, not just a fresh machine. `reportMissingRepos`
 * only reports; it never clones (cloning an arbitrary tracked repo without
 * being asked is exactly the kind of surprise a "regenerate what's
 * re-derivable" step must not spring).
 */

export type MaterializeStep =
  | { kind: "rtInterceptInstall" }
  | { kind: "rtDaemonInstall" }
  | { kind: "reportMissingRepos"; names: string[] }
  | { kind: "deckSetup" }
  | { kind: "boardSetup"; repoPath: string };

/** A step whose failure is rt's own responsibility — gates `rt home init`'s exit code. Any other step failing (a third-party tool, or a report-only step) never aborts the run. */
export const RT_OWN_STEP_KINDS = new Set<MaterializeStep["kind"]>(["rtInterceptInstall", "rtDaemonInstall"]);

export interface MaterializeEnv {
  deckOnPath: boolean;
  /** mr-board's checkout path from the repo index, or null if it isn't cloned locally. */
  boardRepoPath: string | null;
  daemonInstalled: boolean;
  trackedRepos: Array<{ name: string; path: string; present: boolean }>;
}

/**
 * Pure decision only — no fs, no exec. A tool absent from this machine
 * (deck not on PATH, mr-board not cloned) never emits its step at all: the
 * "missing tool = skipped, never a failure" rule is enforced here, at the
 * planning boundary, not by swallowing an executor failure later.
 */
export function planMaterialize(env: MaterializeEnv): MaterializeStep[] {
  const steps: MaterializeStep[] = [{ kind: "rtInterceptInstall" }];

  if (!env.daemonInstalled) steps.push({ kind: "rtDaemonInstall" });

  const missing = env.trackedRepos.filter((r) => !r.present).map((r) => r.name);
  if (missing.length > 0) steps.push({ kind: "reportMissingRepos", names: missing });

  if (env.deckOnPath) steps.push({ kind: "deckSetup" });

  if (env.boardRepoPath) steps.push({ kind: "boardSetup", repoPath: env.boardRepoPath });

  return steps;
}

export interface MaterializeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Shaped exactly like `lib/subprocess.ts`'s `runCapture` so the real seam is a one-line wrap. */
export interface MaterializeExecSeam {
  run(argv: [string, ...string[]], opts?: { cwd?: string }): Promise<MaterializeExecResult>;
}

export interface MaterializeResult {
  step: MaterializeStep;
  ok: boolean;
  stderr: string;
}

/**
 * `mr-board`'s `scripts/setup.ts` prompts interactively (GitLab token, Slack
 * OAuth) and reaches the network — it cannot be run unattended by init. This
 * step is therefore always report-only: it names the command for the
 * operator to run themselves rather than spawning it.
 */
function boardSetupCommand(repoPath: string): string {
  return `cd ${repoPath} && bun run scripts/setup.ts`;
}

async function runStep(step: MaterializeStep, seam: MaterializeExecSeam): Promise<MaterializeResult> {
  switch (step.kind) {
    case "rtInterceptInstall": {
      const r = await seam.run(["rt", "intercept", "install"]);
      return { step, ok: r.exitCode === 0, stderr: r.exitCode === 0 ? "" : r.stderr || `exit ${r.exitCode}` };
    }
    case "rtDaemonInstall": {
      const r = await seam.run(["rt", "daemon", "install"]);
      return { step, ok: r.exitCode === 0, stderr: r.exitCode === 0 ? "" : r.stderr || `exit ${r.exitCode}` };
    }
    case "deckSetup": {
      const r = await seam.run(["deck", "setup"]);
      return { step, ok: r.exitCode === 0, stderr: r.exitCode === 0 ? "" : r.stderr || `exit ${r.exitCode}` };
    }
    case "reportMissingRepos":
      return { step, ok: true, stderr: "" };
    case "boardSetup":
      return { step, ok: true, stderr: `run manually (interactive): ${boardSetupCommand(step.repoPath)}` };
  }
}

/**
 * Runs every step regardless of an earlier step's outcome — one failure must
 * never abort the rest (each step regenerates an independent piece of
 * state). Returns the full per-step result list for the caller to render and
 * to decide the exit code from (only an `RT_OWN_STEP_KINDS` failure should
 * ever fail `rt home init` itself).
 */
export async function runMaterialize(steps: MaterializeStep[], seam: MaterializeExecSeam): Promise<MaterializeResult[]> {
  const results: MaterializeResult[] = [];
  for (const step of steps) {
    results.push(await runStep(step, seam));
  }
  return results;
}
