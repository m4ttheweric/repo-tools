/**
 * MR action IPC handlers — clients dispatch live-MR mutations through the
 * daemon so the daemon's DashboardGroup + provider stay the only path that
 * talks to GitLab. Paired with `mr-subscriptions.ts`, which owns the live
 * subscription and the per-MR `actionsFor()` binding.
 *
 *   mr:action            — merge / rebase / approve / unapprove / etc.
 *   mr:fetch-job-detail  — unified detail fetch (returns trace or bridge)
 *   mr:fetch-job-trace   — raw job trace text
 *
 * Every handler routes by `{ repoName, iid }`. If no live group exists for
 * that pair (no subscription yet, or repo pruned from the index), the handler
 * returns `{ ok: false, error }` so the client can surface a toast.
 */

import { getActions } from "../mr-subscriptions.ts";
import type { HandlerMap } from "./types.ts";

type ActionName =
  | "merge" | "rebase" | "approve" | "unapprove"
  | "setAutoMerge" | "cancelAutoMerge"
  | "retryJob" | "retryPipeline"
  | "toggleDraft" | "requestReReview";

export function createMRHandlers(): HandlerMap {
  return {
    "mr:action": async (payload) => {
      const repoName = payload?.repoName as string | undefined;
      const iid      = payload?.iid      as number | undefined;
      const action   = payload?.action   as ActionName | undefined;
      const args     = (payload?.args as any[] | undefined) ?? [];

      if (!repoName || typeof iid !== "number" || !action) {
        return { ok: false, error: "missing repoName/iid/action" };
      }

      const actions = getActions(repoName, iid);
      if (!actions) {
        return { ok: false, error: `no live subscription for ${repoName}#${iid}` };
      }

      try {
        switch (action) {
          case "merge":            await actions.merge(args[0]);              break;
          case "rebase":           await actions.rebase();                    break;
          case "approve":          await actions.approve();                   break;
          case "unapprove":        await actions.unapprove();                 break;
          case "setAutoMerge":     await actions.setAutoMerge();              break;
          case "cancelAutoMerge":  await actions.cancelAutoMerge();           break;
          case "retryPipeline":    await actions.retryPipeline(args[0]);      break;
          case "retryJob":         await actions.retryJob(args[0]);           break;
          case "toggleDraft":      await actions.toggleDraft(args[0]);        break;
          case "requestReReview":  await actions.requestReReview(args[0]);    break;
          default:
            return { ok: false, error: `unsupported action: ${action}` };
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
      const actions = getActions(repoName, iid);
      if (!actions) return { ok: false, error: `no live subscription for ${repoName}#${iid}` };

      try {
        const detail = await actions.fetchJobDetail(jobId, pipelineId);
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
      const actions = getActions(repoName, iid);
      if (!actions) return { ok: false, error: `no live subscription for ${repoName}#${iid}` };

      try {
        const trace = await actions.fetchJobTrace(jobId);
        return { ok: true, data: trace };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
