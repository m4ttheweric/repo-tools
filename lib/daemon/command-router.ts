/**
 * Command router — assembles the extracted-handler map, built once at startup.
 *
 * Every IPC/REST command goes through a single map lookup in the daemon's
 * handleCommand; only the lifecycle-coupled `shutdown` fall-through remains
 * inline in daemon.ts.
 */

import type { HandlerContext, HandlerMap, TypedHandlers } from "./handlers/types.ts";
import { createCacheHandlers }     from "./handlers/cache.ts";
import { createHooksHandlers }     from "./handlers/hooks.ts";
import { createStatusHandlers }    from "./handlers/status.ts";
import { createWorkspaceHandlers } from "./handlers/workspace.ts";
import { createMRHandlers }        from "./handlers/mr.ts";
import { createWorktreeHandlers, type WorktreeHandlerOpts } from "./handlers/worktree.ts";
import { createDiscussionHandlers } from "./handlers/discussions.ts";
import { createSystemProcessHandlers } from "./handlers/system-processes.ts";
import { createSdmHandlers } from "./handlers/sdm.ts";
import { createSecretsHandlers } from "./handlers/secrets.ts";
import { createProjectMRsHandlers } from "./handlers/project-mrs.ts";
import { createEventsHandlers } from "./handlers/events.ts";
import { createEndpointHandlers } from "./handlers/endpoint.ts";
import { reconcileFreshness, getFreshnessSnapshot } from "./freshness.ts";
import type { SystemProcessScanner } from "./system-process-scanner.ts";
import type { EventsBus } from "./events-bus.ts";

// `TypedHandlers & HandlerMap`, not plain HandlerMap: the intersection makes
// this function the compile-time proof that every command in the rt-client
// catalog has a daemon handler. A catalog entry whose factory stops
// declaring it fails here, before the runtime exhaustiveness test in
// __tests__/rt-client-commands.test.ts ever runs (MAT-31).
export function buildRoutedHandlers(opts: {
  ctx: HandlerContext;
  broadcast: (type: string, data: any) => void;
  systemProcessScanner: SystemProcessScanner;
  /** Reconciler seams the worktree verbs drive (spec §7): claim events, replenish kicks, in-flight creates. */
  worktree: WorktreeHandlerOpts;
  /** Events bus backing events:emit/wait/list (RT-44). */
  eventsBus: EventsBus;
}): TypedHandlers & HandlerMap {
  const { ctx, broadcast, systemProcessScanner } = opts;
  return {
    ...createCacheHandlers(ctx),
    ...createHooksHandlers(ctx),
    ...createStatusHandlers(ctx),
    ...createWorkspaceHandlers(ctx),
    ...createMRHandlers(ctx, broadcast),
    ...createWorktreeHandlers(ctx, opts.worktree),
    ...createDiscussionHandlers(ctx, broadcast),
    ...createSystemProcessHandlers(systemProcessScanner, ctx),
    ...createSdmHandlers(ctx),
    ...createSecretsHandlers(ctx),
    ...createProjectMRsHandlers(ctx, broadcast),
    ...createEventsHandlers(opts.eventsBus, broadcast),
    ...createEndpointHandlers(ctx),

    // Applies repo-tracking edits immediately (rt daemon track <repo>
    // live|poll|off) instead of waiting for the next refresh-tail reconcile.
    "freshness:reconcile": async () => {
      await reconcileFreshness({ ctx, broadcast });
      return { ok: true, data: getFreshnessSnapshot() };
    },
  };
}
