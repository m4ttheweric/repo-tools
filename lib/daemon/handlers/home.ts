/**
 * home:snapshot / home:snapshot-status — thin IPC surface over the
 * home-snapshot module (lib/daemon/home-snapshot.ts).
 *
 * Daemon-internal handlers, not part of the typed rt-client command surface
 * — same posture as settings.ts (plain HandlerMap, no catalog entry): a CLI
 * consumer (rt home snapshot) reaches these through the generic daemon
 * client, not a typed wrapper function.
 */

import type { HomeSnapshotHandle } from "../home-snapshot.ts";
import type { HandlerMap } from "./types.ts";

export function createHomeHandlers(homeSnapshot: HomeSnapshotHandle): Record<"home:snapshot" | "home:snapshot-status", (payload: any) => Promise<any>> & HandlerMap {
  return {
    // The daemon's own "watch"/"janitor" reasons are internal-only — every
    // externally triggered run (this handler is the only trigger a caller
    // outside the daemon has) is "manual" regardless of payload contents.
    "home:snapshot": async () => {
      const result = await homeSnapshot.runNow("manual");
      return { ok: true, data: result };
    },

    "home:snapshot-status": async () => {
      return { ok: true, data: homeSnapshot.status() };
    },
  };
}
