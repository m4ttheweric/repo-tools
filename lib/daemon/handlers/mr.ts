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
import { getDaemonLogger } from "../../daemon-logger.ts";
import type { PullRequest } from "@mattstack/glance";
import type { HandlerContext, HandlerMap } from "./types.ts";

const log = (await getDaemonLogger()).childLogger("mr");

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

export function createMRHandlers(
  ctx: HandlerContext,
  broadcast: (type: string, data: any) => void,
  overrides: MRHandlerOverrides = {},
): HandlerMap {
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
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      const action   = payload?.action   as ActionName | undefined;
      const args     = (payload?.args as any[] | undefined) ?? [];

      if (!repoName || typeof iid !== "number" || !action) {
        return { ok: false, error: "missing repoName/iid/action" };
      }

      try {
        const { provider, projectPath } = await contextFor(repoName);
        let returnedPr: PullRequest | null = null;
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

        const followUp = async () => {
          try {
            const pr = await fetchSingle(provider, projectPath, iid);
            if (pr) writeback(repoName, projectPath, pr);
          } catch (err) {
            log.warn({ err, repo: repoName, iid, action }, "write-back follow-up failed");
          }
        };

        if (RETURNED_PR_ACTIONS.has(action) && returnedPr) {
          // The mutation already succeeded; a failing write-back must not
          // misreport it as failed. Same never-fail contract as followUp.
          try {
            writeback(repoName, projectPath, returnedPr);
          } catch (err) {
            log.warn({ err, repo: repoName, iid, action }, "write-back failed");
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
      const repoName   = payload?.repoName   as string | undefined;
      const iid        = payload?.iid        as number | undefined;
      const jobId      = payload?.jobId      as number | undefined;
      const pipelineId = payload?.pipelineId as number | undefined;

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
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      const jobId    = payload?.jobId    as number | undefined;

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
