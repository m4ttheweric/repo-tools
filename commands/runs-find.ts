/**
 * rt runs find --session <id> [--running] [--json]
 * Agent-facing (a Claude Code Stop hook locating its own run without the
 * daemon or a full listRuns snapshot). Read-side only: scans run DBs
 * directly under runsRoot() via lib/runs/store.ts. Output is always JSON;
 * --json is accepted and ignored for symmetry with the other runs verbs.
 */
import { findRunsBySession } from "../lib/runs/store.ts";

export type CliResult = { out: string; code: number };

function json(value: unknown): string {
  return JSON.stringify(value);
}

// A value flag followed by nothing, or by another flag, means no value was
// given -- matching runs-write.ts's flagValue so a missing --session and a
// dangling --session both surface as the same usage error.
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

export function runFind(args: string[], env: NodeJS.ProcessEnv = process.env): CliResult {
  const session = flagValue(args, "--session");
  if (!session) return { out: json({ ok: false, error: "--session is required" }), code: 2 };

  const running = args.includes("--running");
  // findRunsBySession has no root parameter -- it reads runsRoot() straight
  // from process.env, same as listRuns -- so a caller-supplied env (tests
  // only; production env already is process.env) has to land there for the
  // duration of this call.
  const prevRoot = process.env.RT_RUNS_ROOT;
  if (env.RT_RUNS_ROOT !== undefined) process.env.RT_RUNS_ROOT = env.RT_RUNS_ROOT;
  let matches;
  try {
    matches = findRunsBySession(session);
  } finally {
    process.env.RT_RUNS_ROOT = prevRoot;
  }

  const runs = matches
    .filter((m) => !running || m.summary.status === "running")
    .map((m) => ({
      repo: m.summary.repo, runId: m.summary.id, runDb: m.runDb,
      status: m.summary.status, current_stage: m.summary.current_stage,
      started_at: m.summary.started_at, ended_at: m.summary.ended_at,
    }));
  return { out: json({ ok: true, runs }), code: 0 };
}

export async function runsFind(args: string[]): Promise<void> {
  const r = runFind(args);
  if (r.out !== "") console.log(r.out);
  if (r.code !== 0) process.exit(r.code);
}
