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

/** Shaped like `lib/subprocess.ts`'s `runCapture` so the real seam is a one-line wrap. */
export interface MaterializeExecSeam {
  run(argv: [string, ...string[]], opts?: { timeoutMs?: number }): Promise<MaterializeExecResult>;
}

export interface MaterializeResult {
  step: MaterializeStep;
  ok: boolean;
  stderr: string;
  /** Captured stdout — non-empty only for `RT_OWN_STEP_KINDS` steps, and printed even on `ok: true`: `rt daemon install` writes operator-critical approval guidance to stdout on a clean exit. */
  stdout: string;
  /** An informational note to show even on `ok: true` — e.g. `boardSetup`'s manual-run command. Never a failure message (that's `stderr`). */
  note: string;
}

/**
 * `rt daemon install` polls the tray over HTTP for up to ~27s worst case;
 * `runCapture`'s 10s default would SIGKILL it mid-poll. Applied to every
 * subprocess step here — the `which deck` probe (env gathering, not a step)
 * is deliberately NOT run through this and keeps runCapture's short default.
 */
const STEP_TIMEOUT_MS = 60_000;

/** `mr-board`'s `scripts/setup.ts` prompts interactively (GitLab token, Slack OAuth) and reaches the network — it cannot be run unattended by init. */
function boardSetupCommand(repoPath: string): string {
  return `cd "${repoPath}" && bun run scripts/setup.ts`;
}

function ok(step: MaterializeStep, stdout = ""): MaterializeResult {
  return { step, ok: true, stderr: "", stdout, note: "" };
}

function failureMessage(bin: string, r: MaterializeExecResult): string {
  if (r.exitCode === -1) return `could not run \`${bin}\` — is it on PATH?`;
  return r.stderr || `exit ${r.exitCode}`;
}

async function runSubprocessStep(
  step: MaterializeStep,
  bin: string,
  argv: [string, ...string[]],
  seam: MaterializeExecSeam,
  captureStdout: boolean,
): Promise<MaterializeResult> {
  const r = await seam.run(argv, { timeoutMs: STEP_TIMEOUT_MS });
  const succeeded = r.exitCode === 0;
  return {
    step,
    ok: succeeded,
    stderr: succeeded ? "" : failureMessage(bin, r),
    stdout: captureStdout ? r.stdout.trim() : "",
    note: "",
  };
}

async function runStep(step: MaterializeStep, seam: MaterializeExecSeam): Promise<MaterializeResult> {
  switch (step.kind) {
    case "rtInterceptInstall":
      return runSubprocessStep(step, "rt", ["rt", "intercept", "install"], seam, true);
    case "rtDaemonInstall":
      return runSubprocessStep(step, "rt", ["rt", "daemon", "install"], seam, true);
    case "deckSetup":
      return runSubprocessStep(step, "deck", ["deck", "setup"], seam, false);
    case "reportMissingRepos":
      return ok(step);
    case "boardSetup":
      return { step, ok: true, stderr: "", stdout: "", note: `run manually (interactive): ${boardSetupCommand(step.repoPath)}` };
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
