/**
 * Command router — assembles the extracted-handler map, built once at startup.
 *
 * Every IPC/REST command goes through a single map lookup in the daemon's
 * handleCommand; only the lifecycle-coupled `shutdown` fall-through remains
 * inline in daemon.ts.
 */

import type { HandlerContext, HandlerMap } from "./handlers/types.ts";
import { createCacheHandlers }     from "./handlers/cache.ts";
import { createRemedyHandlers }    from "./handlers/remedy.ts";
import { createProxyHandlers }     from "./handlers/proxy.ts";
import { createTunnelHandlers }    from "./handlers/tunnel.ts";
import { createProcessHandlers }   from "./handlers/process.ts";
import { createHooksHandlers }     from "./handlers/hooks.ts";
import { createStatusHandlers }    from "./handlers/status.ts";
import { createPortsHandlers }     from "./handlers/ports.ts";
import { createGroupsHandlers }    from "./handlers/groups.ts";
import { createWorkspaceHandlers } from "./handlers/workspace.ts";
import { createMRHandlers }        from "./handlers/mr.ts";
import { createParkingLotHandlers } from "./handlers/parking-lot.ts";
import { createDopplerHandlers }   from "./handlers/doppler.ts";
import { createDiscussionHandlers } from "./handlers/discussions.ts";
import { createEndpointHandlers }  from "./handlers/endpoints.ts";
import { createSystemProcessHandlers } from "./handlers/system-processes.ts";
import type { SystemProcessScanner } from "./system-process-scanner.ts";

export function buildRoutedHandlers(opts: {
  ctx: HandlerContext;
  broadcast: (type: string, data: any) => void;
  systemProcessScanner: SystemProcessScanner;
}): HandlerMap {
  const { ctx, broadcast, systemProcessScanner } = opts;
  return {
    ...createCacheHandlers(ctx),
    ...createRemedyHandlers(ctx),
    ...createProxyHandlers(ctx),
    ...createTunnelHandlers(ctx),
    ...createProcessHandlers(ctx),
    ...createHooksHandlers(ctx),
    ...createStatusHandlers(ctx),
    ...createPortsHandlers(ctx),
    ...createGroupsHandlers(ctx),
    ...createWorkspaceHandlers(ctx),
    ...createMRHandlers(),
    ...createParkingLotHandlers(ctx),
    ...createDopplerHandlers(ctx),
    ...createDiscussionHandlers(ctx, broadcast),
    ...createEndpointHandlers(ctx),
    ...createSystemProcessHandlers(systemProcessScanner, ctx),
  };
}
