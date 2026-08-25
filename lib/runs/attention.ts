/**
 * The needs-attention predicate (SKILLS-53). Computed here so the console and
 * the tray read one judgment instead of deriving two that can disagree.
 *
 * Derived state carries the evidence that produced it: "no event in 41m" is a
 * claim the reader can check, "stale" alone is not.
 */
import type { Attention, RunDecisionRow, RunFieldRow, RunStageRow, RunSummary } from "../../packages/rt-client/src/commands.ts";

// `Attention` is declared in rt-client (see below): mr-board and gitq consume
// that package as a file: dependency and must never import rt internals.

export const STALE_MS = 30 * 60 * 1000;

const NONE: Attention = { needs: false, reason: null, evidence: "" };

// Every write the helper makes counts as a heartbeat, not just stage
// transitions: stages write their declared produces the moment those exist, so
// a long implement stage is alive through `fields.at` while no stage boundary
// moves at all. `run.started_at` is a fallback for a run with no recorded
// events at all, not a floor on the events that do exist — a stage that
// started long before the run's own started_at column caught up (clock skew
// on resume, backfilled rows) must still be measured by its own timestamp.
export function lastEventAt(run: RunSummary, stages: RunStageRow[], fields: RunFieldRow[], decisions: RunDecisionRow[]): number {
  let last: number | null = null;
  const bump = (t: number | null | undefined) => { if (t != null && (last == null || t > last)) last = t; };
  for (const s of stages) { bump(s.started_at); bump(s.ended_at); }
  for (const f of fields) bump(f.at);
  for (const d of decisions) bump(d.decided_at);
  return last ?? run.started_at;
}

// `fields` is one row per key (see the table's primary key in
// lib/runs/__tests__/fixtures.ts), so there's never more than one candidate.
export function fieldValue(fields: RunFieldRow[], key: string): string | null {
  return fields.find((f) => f.key === key)?.value ?? null;
}

function has(fields: RunFieldRow[], key: string): boolean {
  return fields.some((f) => f.key === key);
}

/**
 * Out-of-band evidence that a DB-silent run is still being driven. Provided
 * by lib/runs/liveness.ts; attention stays pure by taking it as an argument.
 */
export interface RunLiveness {
  /** Pane id of a `working` herdr agent running this claude session. */
  workingSessionPane(sessionId: string): string | null;
  /** Pane id of a `working` herdr agent whose cwd sits in this worktree. */
  workingAgentPane(worktree: string): string | null;
  /** Latest git-activity mtime in the worktree, or null when unstatable. */
  worktreeActiveAt(worktree: string): number | null;
}

export function computeAttention(
  run: RunSummary,
  stages: RunStageRow[],
  fields: RunFieldRow[],
  decisions: RunDecisionRow[],
  now: number,
  liveness?: RunLiveness,
): Attention {
  if (run.status === "failed") {
    const worst = stages.filter((s) => s.status === "failed").at(-1);
    const where = worst ? `${worst.name}, attempt ${worst.attempt}` : "unknown stage";
    return { needs: true, reason: "failed", evidence: `failed at ${where}${worst?.reason ? `: ${worst.reason}` : ""}` };
  }

  if (run.status === "running") {
    const silentMs = now - lastEventAt(run, stages, fields, decisions);
    if (silentMs > STALE_MS) {
      const mins = Math.round(silentMs / 60_000);
      const stage = run.current_stage ?? "an unknown stage";
      // Stage boundaries are the only guaranteed DB writes, so a long stage is
      // silent by design. Before claiming stale, walk the liveness ladder —
      // the run's recorded claude session working anywhere, a working agent
      // in the worktree, recent git activity there — and stay quiet while any
      // rung holds. A working agent suppresses stale indefinitely: attention
      // means "nobody is driving this", not "this is taking long". The
      // evidence string still only asserts what was actually measured.
      const worktree = fieldValue(fields, "worktree");
      const session = fieldValue(fields, "claude-session");
      let checked = "";
      if (liveness && (worktree || session)) {
        if (session && liveness.workingSessionPane(session) != null) return NONE;
        if (worktree) {
          if (liveness.workingAgentPane(worktree) != null) return NONE;
          const activeAt = liveness.worktreeActiveAt(worktree);
          if (activeAt != null && now - activeAt <= STALE_MS) return NONE;
          const quiet = activeAt != null ? `worktree quiet ${Math.round((now - activeAt) / 60_000)}m` : "worktree unstatable";
          checked = `, ${quiet}, no agent working there`;
        } else {
          checked = ", its session's agent is not working";
        }
      }
      return {
        needs: true,
        reason: "stale",
        evidence: `no event in ${mins}m while in ${stage}${checked}; threshold is ${Math.round(STALE_MS / 60_000)}m`,
      };
    }
    return NONE;
  }

  if (run.status === "done") {
    // Stranded means the work never reached review. `mr` is the field key
    // stage-ship declares (stage-produces: "mr") and writes; an MR merely OPEN
    // is mr-board's surface, so its presence clears this entirely. `commits` is
    // what stage-implement produces, so requiring it keeps review-only and
    // watch-only pipelines out of the band.
    if (has(fields, "commits") && !has(fields, "mr")) {
      return { needs: true, reason: "stranded", evidence: "finished with commits but no MR was ever opened" };
    }
  }

  return NONE;
}
