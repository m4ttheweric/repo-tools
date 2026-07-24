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
 */

import { getRepoContext } from "../freshness.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

type ActionName =
  | "merge" | "rebase" | "approve" | "unapprove"
  | "setAutoMerge" | "cancelAutoMerge"
  | "retryJob" | "retryPipeline"
  | "toggleDraft" | "requestReReview";

export function createMRHandlers(ctx: HandlerContext): HandlerMap {
  function contextFor(repoName: string) {
    return getRepoContext(repoName, ctx.repoIndex()[repoName]);
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
        switch (action) {
          case "merge":            await provider.mergePullRequest(projectPath, iid, args[0]);          break;
          case "rebase":           await provider.rebasePullRequest(projectPath, iid);                  break;
          case "approve":          await provider.approvePullRequest(projectPath, iid);                 break;
          case "unapprove":        await provider.unapprovePullRequest(projectPath, iid);               break;
          case "setAutoMerge":     await provider.setAutoMerge(projectPath, iid);                       break;
          case "cancelAutoMerge":  await provider.cancelAutoMerge(projectPath, iid);                    break;
          case "retryPipeline":    await provider.retryPipeline(projectPath, args[0]);                  break;
          case "retryJob":         await provider.retryJob(projectPath, args[0]);                       break;
          case "toggleDraft":      await provider.updatePullRequest(projectPath, iid, { draft: args[0] }); break;
          case "requestReReview":  await provider.requestReReview(projectPath, iid, args[0]);           break;
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
