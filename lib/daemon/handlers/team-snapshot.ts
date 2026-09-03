/**
 * team:snapshot-status / team:pull, a thin IPC surface over the
 * team-snapshot supervisor (lib/daemon/team-snapshots.ts). Same posture as
 * home.ts: no rt-client catalog entry, reached through the generic daemon
 * client.
 */

import { UserActionableError } from "../../setup/errors.ts";
import type { TeamSnapshotsHandle } from "../team-snapshots.ts";
import type { HandlerMap } from "./types.ts";

export function createTeamSnapshotHandlers(teamSnapshots: TeamSnapshotsHandle): Record<"team:snapshot-status" | "team:pull", (payload: any) => Promise<any>> & HandlerMap {
  return {
    "team:snapshot-status": async () => {
      return { ok: true, data: teamSnapshots.status() };
    },

    "team:pull": async (payload: any) => {
      try {
        return { ok: true, data: await teamSnapshots.pullNow(String(payload?.slug ?? "")) };
      } catch (err) {
        // pullNow's only throw for an out-of-band slug is UserActionableError
        // ("no-team"); anything else is a real bug and must propagate.
        if (err instanceof UserActionableError) {
          return { ok: false, error: err.message, failure: { code: err.code, message: err.message } };
        }
        throw err;
      }
    },
  };
}
