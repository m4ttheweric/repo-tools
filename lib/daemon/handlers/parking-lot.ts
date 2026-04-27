/**
 * Parking-lot IPC handlers.
 *
 *   parking-lot:scan  — run the auto-park check immediately (manual trigger
 *                       from `rt parking-lot scan`). Returns a terse summary
 *                       the CLI can print.
 */

import { checkAndPark } from "../parking-lot.ts";
import type { HandlerContext, HandlerMap } from "./types.ts";

export function createParkingLotHandlers(ctx: HandlerContext): HandlerMap {
  return {
    "parking-lot:scan": async () => {
      // Capture log lines emitted during the scan so we can echo them back
      // to the CLI caller. The daemon's own log still gets them too.
      const lines: string[] = [];
      const tee = (msg: string) => {
        lines.push(msg);
        ctx.log(msg);
      };

      try {
        checkAndPark({ cache: ctx.cache, repoIndex: ctx.repoIndex, log: tee });
        return { ok: true, data: { lines } };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}
