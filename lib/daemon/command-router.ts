/**
 * Command router — assembles the extracted-handler map, built once at startup.
 *
 * Every IPC/REST command goes through a single map lookup in the daemon's
 * handleCommand; only the lifecycle-coupled `shutdown` fall-through remains
 * inline in daemon.ts.
 */

import type { HandlerContext, HandlerMap } from "./handlers/types.ts";
import { createCacheHandlers }     from "./handlers/cache.ts";
import { createHooksHandlers }     from "./handlers/hooks.ts";
import { createStatusHandlers }    from "./handlers/status.ts";
import { createWorkspaceHandlers } from "./handlers/workspace.ts";
import { createMRHandlers }        from "./handlers/mr.ts";
import { createParkingLotHandlers } from "./handlers/parking-lot.ts";
import { createDiscussionHandlers } from "./handlers/discussions.ts";
import { createSystemProcessHandlers } from "./handlers/system-processes.ts";
import { createSdmHandlers } from "./handlers/sdm.ts";
import { reconcileFreshness, getFreshnessSnapshot } from "./freshness.ts";
import type { SystemProcessScanner } from "./system-process-scanner.ts";

export function buildRoutedHandlers(opts: {
  ctx: HandlerContext;
  broadcast: (type: string, data: any) => void;
  systemProcessScanner: SystemProcessScanner;
}): HandlerMap {
  const { ctx, broadcast, systemProcessScanner } = opts;
  return {
    ...createCacheHandlers(ctx),
    ...createHooksHandlers(ctx),
    ...createStatusHandlers(ctx),
    ...createWorkspaceHandlers(ctx),
    ...createMRHandlers(ctx),
    ...createParkingLotHandlers(ctx),
    ...createDiscussionHandlers(ctx, broadcast),
    ...createSystemProcessHandlers(systemProcessScanner, ctx),
    ...createSdmHandlers(ctx),

    // Applies events-watch allowlist edits immediately (rt daemon events
    // <repo> on|off) instead of waiting for the next refresh-tail reconcile.
    "freshness:reconcile": async () => {
      await reconcileFreshness({ ctx, broadcast });
      return { ok: true, data: getFreshnessSnapshot() };
    },
  };
}
