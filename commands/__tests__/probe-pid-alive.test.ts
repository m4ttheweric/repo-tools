import { describe, test, expect } from "bun:test";
import { probePidAlive } from "../daemon.ts";
import { readSupervisionState } from "../../lib/daemon/supervision-state.ts";

describe("probePidAlive", () => {
  // Regression: the lsof fallback must exclude the CALLING process itself.
  // showStatus opens a bun:sqlite handle on state.db (inside RT_DIR) via
  // readSupervisionState() immediately before this probe runs — `lsof +D
  // RT_DIR` then legitimately reports the calling CLI process as a live
  // holder of the directory, with no daemon involved at all. Without the
  // process.pid filter this self-matches and a genuinely dead daemon
  // (no recorded pid, no breadcrumb pid) misclassifies as alive.
  test("a state.db handle held by THIS process does not self-match as a live daemon", async () => {
    readSupervisionState(); // opens (and keeps open) the isolated HOME's state.db
    const result = await probePidAlive(null, undefined);
    expect(result.alive).toBe(false);
    expect(result.pid).toBeNull();
  });
});
