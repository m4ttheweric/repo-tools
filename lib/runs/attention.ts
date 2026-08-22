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
function lastEventAt(run: RunSummary, stages: RunStageRow[], fields: RunFieldRow[], decisions: RunDecisionRow[]): number {
  let last: number | null = null;
  const bump = (t: number | null | undefined) => { if (t != null && (last == null || t > last)) last = t; };
  for (const s of stages) { bump(s.started_at); bump(s.ended_at); }
  for (const f of fields) bump(f.at);
  for (const d of decisions) bump(d.decided_at);
  return last ?? run.started_at;
}

function has(fields: RunFieldRow[], key: string): boolean {
  return fields.some((f) => f.key === key);
}

export function computeAttention(
  run: RunSummary,
  stages: RunStageRow[],
  fields: RunFieldRow[],
  decisions: RunDecisionRow[],
  now: number,
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
      // The spec's condition 2 also says "no owning process". Process liveness
      // is deliberately NOT checked in v1: a run's owning process is a Claude
      // session this machine cannot reliably attribute, and a wrong "no process"
      // claim is worse than a silence measurement the reader can verify. The
      // evidence therefore says exactly what was measured and nothing more.
      return {
        needs: true,
        reason: "stale",
        evidence: `no event in ${mins}m while in ${stage}; threshold is ${Math.round(STALE_MS / 60_000)}m`,
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
