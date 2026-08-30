/**
 * MR action IPC handlers — clients dispatch MR mutations through the daemon
 * so the daemon's per-repo provider stays the only path that talks to GitLab.
 * Providers come from freshness.ts (getRepoContext), which serves live-watch
 * and ephemeral repos alike.
 *
 *   mr:action            — merge / rebase / approve / unapprove / etc.
 *   mr:fetch-job-detail  — unified detail fetch (returns trace or bridge)
 *   mr:fetch-job-trace   — raw job trace text
 *
 * Every handler routes by `{ repoName, iid }`. If no provider can be built
 * for the repo (missing token, unparseable remote), the handler returns
 * `{ ok: false, error }` so the client can surface a toast.
 *
 * mr:action write-back (spec §5.4): a mutation only ever tells us the MR
 * changed, not the fresh shape of every field (approvals, pipeline status,
 * ...). Three buckets decide how we get that fresh shape into the stores:
 *   - returned-PR (merge, toggleDraft) — the SDK call itself returns the
 *     fresh PullRequest, so write-back is free (zero extra fetches).
 *   - void (approve, unapprove, rebase, setAutoMerge, cancelAutoMerge,
 *     requestReReview) — one immediate fetchSingleMR follow-up.
 *   - retry (retryPipeline, retryJob) — pipelines are the events blind
 *     spot; one DELAYED follow-up catches the flip to "running" (the
 *     final pass/fail rides the normal 5-min cycle).
 * Follow-up failures log at warn and never fail the action.
 */

import { applyMRWriteback, getCurrentUserId, getRepoContext } from "../freshness.ts";
import type { PullRequest } from "@mattstack/glance";
import { ReadBackFailedError } from "@mattstack/glance";
import type { HandlerContext, HandlerMap, CommandResult } from "./types.ts";

type ActionName =
  | "merge" | "rebase" | "approve" | "unapprove"
  | "setAutoMerge" | "cancelAutoMerge"
  | "retryJob" | "retryPipeline"
  | "toggleDraft" | "requestReReview";

export const RETRY_WRITEBACK_DELAY_MS = 5000;

const RETURNED_PR_ACTIONS = new Set<ActionName>(["merge", "toggleDraft"]);
const RETRY_ACTIONS       = new Set<ActionName>(["retryPipeline", "retryJob"]);

export interface MRHandlerOverrides {
  getContext?:  (repoName: string) => Promise<{ provider: any; projectPath: string }>;
  writeback?:   (repoName: string, projectPath: string, pr: PullRequest) => void;
  fetchSingle?: (provider: any, projectPath: string, iid: number) => Promise<PullRequest | null>;
  retryDelayMs?: number;
}

// "mr:action" keeps its pre-existing flat `{ok:true}` wire reply (no `data`)
// verbatim, so it stays on the loose `Promise<any>` escape hatch (same trick
// as endpoint.ts/repos.ts); the two job-detail verbs already envelope as
// {ok,data} and get the standard CommandResult carve-out.
export function createMRHandlers(
  ctx: Pick<HandlerContext, "repoIndex" | "cache" | "log">,
  broadcast: (type: string, data: any) => void,
  overrides: MRHandlerOverrides = {},
): { "mr:action": (payload: any, signal?: AbortSignal) => Promise<any> }
  & { "mr:fetch-job-detail": (payload: unknown, signal?: AbortSignal) => Promise<CommandResult<"mr:fetch-job-detail">> }
  & { "mr:fetch-job-trace": (payload: unknown, signal?: AbortSignal) => Promise<CommandResult<"mr:fetch-job-trace">> }
  & HandlerMap {
  const getContext = overrides.getContext
    ?? ((repoName: string) => getRepoContext(repoName, ctx.repoIndex()[repoName]));
  const writeback = overrides.writeback
    ?? ((repoName: string, projectPath: string, pr: PullRequest) =>
        applyMRWriteback({ ctx, broadcast }, repoName, projectPath, pr));
  const fetchSingle = overrides.fetchSingle
    ?? ((provider: any, projectPath: string, iid: number) =>
        provider.fetchSingleMR(projectPath, iid, getCurrentUserId()));
  const retryDelayMs = overrides.retryDelayMs ?? RETRY_WRITEBACK_DELAY_MS;

  function contextFor(repoName: string) {
    return getContext(repoName);
  }

  return {
    "mr:action": async (payload) => {
      const p = payload as { repoName?: string; iid?: number; action?: ActionName; args?: any[] } | undefined;
      const repoName = p?.repoName;
      const iid      = p?.iid;
      const action   = p?.action;
      const args     = p?.args ?? [];

      if (!repoName || typeof iid !== "number" || !action) {
        return { ok: false, error: "missing repoName/iid/action" };
      }

      try {
        const { provider, projectPath } = await contextFor(repoName);
        let returnedPr: PullRequest | null = null;
        try {
          switch (action) {
            case "merge":            returnedPr = await provider.mergePullRequest(projectPath, iid, args[0]);          break;
            case "rebase":           await provider.rebasePullRequest(projectPath, iid);                  break;
            case "approve":          await provider.approvePullRequest(projectPath, iid);                 break;
            case "unapprove":        await provider.unapprovePullRequest(projectPath, iid);               break;
            case "setAutoMerge":     await provider.setAutoMerge(projectPath, iid);                       break;
            case "cancelAutoMerge":  await provider.cancelAutoMerge(projectPath, iid);                    break;
            case "retryPipeline":    await provider.retryPipeline(projectPath, args[0]);                  break;
            case "retryJob":         await provider.retryJob(projectPath, args[0]);                       break;
            case "toggleDraft":      returnedPr = await provider.updatePullRequest(projectPath, iid, { draft: args[0] }); break;
            case "requestReReview":  await provider.requestReReview(projectPath, iid, args[0]);           break;
            default:
              return { ok: false, error: `unsupported action: ${action}` };
          }
        } catch (err) {
          // The two returned-PR actions read the MR back after mutating it, and
          // that read can fail over a mutation that already landed -- GitLab's
          // GraphQL times out on the dashboard fragment often enough to matter.
          // Reporting those as failed put a toast in front of the user for a
          // merge or draft flip that had actually happened, and invited them to
          // do it again. `writeApplied` is the SDK saying the write is on the
          // forge and only describing it failed (glance 0.19.0, MAT-169).
          //
          // `returnedPr` stays null, which drops through to the same follow-up
          // fetch the void actions use, so the stores still get a fresh shape.
          if (!(err instanceof ReadBackFailedError && err.writeApplied)) throw err;
          ctx.log.warn({ err, repo: repoName, iid, action }, "action landed but its read-back failed; recovering via follow-up fetch");
        }

        const followUp = async () => {
          try {
            const pr = await fetchSingle(provider, projectPath, iid);
            if (pr) writeback(repoName, projectPath, pr);
          } catch (err) {
            ctx.log.warn({ err, repo: repoName, iid, action }, "write-back follow-up failed");
          }
        };

        if (RETURNED_PR_ACTIONS.has(action) && returnedPr) {
          // The mutation already succeeded; a failing write-back must not
          // misreport it as failed. Same never-fail contract as followUp.
          try {
            writeback(repoName, projectPath, returnedPr);
          } catch (err) {
            ctx.log.warn({ err, repo: repoName, iid, action }, "write-back failed");
          }
        } else if (RETRY_ACTIONS.has(action)) {
          // Pipelines are the events blind spot: one delayed fetch catches
          // the flip to "running"; the final pass/fail rides the 5-min cycle.
          setTimeout(() => { followUp(); }, retryDelayMs);
        } else {
          await followUp();
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    "mr:fetch-job-detail": async (payload) => {
      const p = payload as { repoName?: string; iid?: number; jobId?: number; pipelineId?: number } | undefined;
      const repoName   = p?.repoName;
      const iid        = p?.iid;
      const jobId      = p?.jobId;
      const pipelineId = p?.pipelineId;

      if (!repoName || typeof iid !== "number" || typeof jobId !== "number") {
        return { ok: false, error: "missing repoName/iid/jobId" };
      }

      try {
        const { provider, projectPath } = await contextFor(repoName);
        const detail = await provider.fetchJobDetail(projectPath, jobId, pipelineId);
        return { ok: true, data: detail };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    "mr:fetch-job-trace": async (payload) => {
      const p = payload as { repoName?: string; iid?: number; jobId?: number } | undefined;
      const repoName = p?.repoName;
      const iid      = p?.iid;
      const jobId    = p?.jobId;

      if (!repoName || typeof iid !== "number" || typeof jobId !== "number") {
        return { ok: false, error: "missing repoName/iid/jobId" };
      }

      try {
        const { provider, projectPath } = await contextFor(repoName);
        const trace = await provider.fetchJobTrace(projectPath, jobId);
        return { ok: true, data: trace };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
