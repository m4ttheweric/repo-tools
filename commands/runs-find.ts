/**
 * rt runs find --session <id> [--running] [--json]
 * Agent-facing (a Claude Code Stop hook locating its own run without the
 * daemon or a full listRuns snapshot). Read-side only: scans run DBs
 * directly under runsRoot() via lib/runs/store.ts. Output is always JSON;
 * --json is accepted and ignored for symmetry with the other runs verbs.
 */
import { required, Usage } from "../lib/cli-args.ts";
import { findRunsBySession } from "../lib/runs/store.ts";

export type CliResult = { out: string; code: number };

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function runFind(args: string[]): CliResult {
  try {
    const session = required(args, "--session");
    const running = args.includes("--running");
    const runs = findRunsBySession(session)
      .filter((m) => !running || m.summary.status === "running")
      .map((m) => ({
        repo: m.summary.repo, runId: m.summary.id, runDb: m.runDb,
        status: m.summary.status, current_stage: m.summary.current_stage,
        started_at: m.summary.started_at, ended_at: m.summary.ended_at,
      }));
    return { out: json({ ok: true, runs }), code: 0 };
  } catch (err) {
    if (err instanceof Usage) return { out: json({ ok: false, error: err.message }), code: 2 };
    throw err;
  }
}

export async function runsFind(args: string[]): Promise<void> {
  const r = runFind(args);
  if (r.out !== "") console.log(r.out);
  if (r.code !== 0) process.exit(r.code);
}
