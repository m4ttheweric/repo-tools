/**
 * The ship relay — the ONLY path sandbox work takes to the real origin.
 * No forge write credential exists in-cluster, ever; the agent pushes to
 * the receiver as refs/sandboxes/<id>/<branch>, and locally `rt sandbox
 * ship` fetches that ref, shows what it is, and pushes to origin under the
 * operator's local identity ONLY after an explicit confirmation. The
 * no-confirm path pushes nothing (asserted by test — that assertion is the
 * point of this module).
 *
 * Unit-tested with an injected git runner; the receiver fetch leg is
 * cluster-verify pending.
 */

import { receiverRepoUrl, receiverSshEnv, receiverSshRemedy } from "./validate-farm.ts";

/** One injected runner for every git leg (fetch needs env, summaries stdout). */
export type GitRun = (
  argv: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Real GitRun. */
export const runGit: GitRun = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

/** Where the agent's work lands on the receiver (pruned on destroy). */
export function sandboxShipRef(sandboxId: string, branch: string): string {
  return `refs/sandboxes/${sandboxId}/${branch}`;
}

export interface ShipSummary {
  branch: string;
  commit: string;
  diffstat: string;
  log: string;
}

/**
 * Fetch → summarize → confirm → push. Returns pushed:false when the
 * operator declines; every failure before the confirmation short-circuits
 * without anything leaving the machine.
 */
export async function shipSandbox(opts: {
  repoId: string;
  sandboxId: string;
  branch: string;
  /** Base ref for the merge-base the summary diffs against. */
  baseRef: string;
  cwd: string;
  git: GitRun;
  confirm: (summary: ShipSummary) => Promise<boolean>;
  env?: Record<string, string | undefined>;
  reposRoot?: string;
}): Promise<
  | { ok: true; pushed: boolean; summary: ShipSummary }
  | { ok: false; message: string }
> {
  const { cwd, git } = opts;

  const fetch = await git(
    ["git", "fetch", receiverRepoUrl(opts.repoId), sandboxShipRef(opts.sandboxId, opts.branch)],
    { cwd, env: receiverSshEnv(opts.env ?? process.env, opts.repoId, opts.reposRoot) },
  );
  if (fetch.exitCode !== 0) {
    const remedy = receiverSshRemedy(fetch.stderr, { repoId: opts.repoId, url: receiverRepoUrl(opts.repoId) });
    return {
      ok: false,
      message: `receiver fetch of ${sandboxShipRef(opts.sandboxId, opts.branch)} failed: ${fetch.stderr.trim()}${remedy ? `\n${remedy}` : ""}`,
    };
  }

  // Summary legs run locally — no env pinning needed.
  const revParse = await git(["git", "rev-parse", "FETCH_HEAD"], { cwd });
  if (revParse.exitCode !== 0) return { ok: false, message: "FETCH_HEAD unreadable after the fetch" };
  const commit = revParse.stdout.trim();

  const mergeBase = await git(["git", "merge-base", "FETCH_HEAD", opts.baseRef], { cwd });
  // A missing merge-base (unrelated histories) still deserves a summary —
  // fall back to the commit itself so the operator sees *something* honest.
  const base = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : null;
  const log = base
    ? await git(["git", "log", "--oneline", `${base}..FETCH_HEAD`], { cwd })
    : await git(["git", "log", "--oneline", "-10", "FETCH_HEAD"], { cwd });
  const diff = base
    ? await git(["git", "diff", "--stat", base, "FETCH_HEAD"], { cwd })
    : { stdout: "(no merge-base with the base ref — diffstat unavailable)", exitCode: 0, stderr: "" };

  const summary: ShipSummary = {
    branch: opts.branch,
    commit,
    log: log.stdout.trimEnd(),
    diffstat: diff.stdout.trimEnd(),
  };

  if (!(await opts.confirm(summary))) {
    return { ok: true, pushed: false, summary };
  }

  // The operator's LOCAL identity: plain push to origin, no receiver env.
  const push = await git(["git", "push", "origin", `FETCH_HEAD:refs/heads/${opts.branch}`], { cwd });
  if (push.exitCode !== 0) {
    return { ok: false, message: `push to origin failed: ${push.stderr.trim()}` };
  }
  return { ok: true, pushed: true, summary };
}
