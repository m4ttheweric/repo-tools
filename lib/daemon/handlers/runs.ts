/**
 * runs:* — pipeline run state (SKILLS-28). These handlers read each DB
 * readonly per request and hold nothing, with one exception: runs:abandon,
 * which writes through reconcile.ts because only a person can decide a run
 * is dead.
 */
import { findRun, listRuns, readRun } from "../../runs/store.ts";
import { abandonRun } from "../../runs/reconcile.ts";
import type { HandlerContext, HandlerMap, TypedHandlers, CommandResult } from "./types.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";

export function createRunsHandlers(
  ctx: HandlerContext,
  emitEvent: (topic: string, payload: unknown) => void,
): Pick<TypedHandlers, "runs:list" | "runs:get" | "runs:abandon"> & HandlerMap {
  const handlers: Pick<TypedHandlers, "runs:list" | "runs:get" | "runs:abandon"> & HandlerMap = {
    "runs:list": async (payload: Commands["runs:list"]["payload"]): Promise<CommandResult<"runs:list">> => {
      // `repo` here is the run DIRECTORY's name — whatever key the pipeline
      // that wrote the run used, surfaced verbatim by runs:list. It is NOT
      // required to parse as an identity: refusing non-identity keys on this
      // read-only surface would 404 exactly the keys runs:list itself hands
      // out for pre-cutover runs.
      try {
        return { ok: true as const, data: { runs: listRuns(payload?.repo || undefined) } };
      } catch (err) {
        ctx.log.warn({ err }, "runs:list failed");
        return { ok: false as const, error: String(err) };
      }
    },
    "runs:get": async (payload: Commands["runs:get"]["payload"]): Promise<CommandResult<"runs:get">> => {
      const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) return { ok: false as const, error: "missing runId" };
      try {
        const detail = payload?.repo ? readRun(payload.repo, runId) : findRun(runId);
        if (!detail) return { ok: false as const, error: "run not found" };
        return { ok: true as const, data: detail };
      } catch (err) {
        ctx.log.warn({ err, runId }, "runs:get failed");
        return { ok: false as const, error: String(err) };
      }
    },
    "runs:abandon": async (payload: Commands["runs:abandon"]["payload"]): Promise<CommandResult<"runs:abandon">> => {
      const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) return { ok: false as const, error: "missing runId" };
      try {
        // Resolve the repo the same way runs:get does, so an id that works for
        // one verb works for the other.
        const detail = payload?.repo ? readRun(payload.repo, runId) : findRun(runId);
        if (!detail) return { ok: false as const, error: "run not found" };
        const res = abandonRun(detail.run.repo, runId, payload.reason ?? "reconciled by hand");
        if (!res.ok) return { ok: false as const, error: res.error };
        emitEvent("run-updated", { repo: detail.run.repo, runId, stage: null, kind: "abandoned" });
        return { ok: true as const, data: { ok: true } };
      } catch (err) {
        ctx.log.warn({ err, runId }, "runs:abandon failed");
        return { ok: false as const, error: String(err) };
      }
    },
  };
  return handlers;
}
