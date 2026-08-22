/**
 * runs:* — read-only pipeline run state (SKILLS-28). rt never writes run
 * state; these handlers open each DB readonly per request and hold nothing.
 */
import { findRun, listRuns, readRun } from "../../runs/store.ts";
import type { HandlerContext, HandlerMap, TypedHandlers, CommandResult } from "./types.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";

export function createRunsHandlers(ctx: HandlerContext): Pick<TypedHandlers, "runs:list" | "runs:get"> & HandlerMap {
  const handlers: Pick<TypedHandlers, "runs:list" | "runs:get"> & HandlerMap = {
    "runs:list": async (payload: Commands["runs:list"]["payload"]): Promise<CommandResult<"runs:list">> => {
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
  };
  return handlers;
}
