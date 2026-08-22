/**
 * MAT-222: the notification fallback must never block the daemon's event
 * loop. The live wedge was notifyFallback's synchronous exec of the CLI
 * notifier: Bun's sync-exec `timeout` only SIGTERMs and then waits for the
 * child indefinitely, so a notifier binary that hangs and shrugs off SIGTERM
 * (osascript stuck on Notification Center/TCC from the launchd daemon
 * context) parked the main thread for minutes per notification — every API
 * route and the unix socket accepted but never answered.
 *
 * The fake notifier here reproduces that child: it ignores SIGTERM and
 * sleeps far longer than any sane notification takes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __test__ } from "../notifier.ts";

afterEach(() => {
  __test__.setFallbackNotifier(null);
});

function fakeHangingNotifier(sleepSecs: number): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-fake-tn-"));
  const path = join(dir, "osascript");
  writeFileSync(path, `#!/bin/sh\ntrap '' TERM\nsleep ${sleepSecs}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("notifyFallback event-loop safety (MAT-222)", () => {
  test(
    "returns immediately and never starves timers while the notifier child hangs",
    async () => {
      __test__.setFallbackNotifier(fakeHangingNotifier(15));

      let heartbeats = 0;
      const heart = setInterval(() => { heartbeats++; }, 25);

      const t0 = Date.now();
      __test__.notifyFallback("MAT-222 test", "fallback must not block");
      const callMs = Date.now() - t0;

      // Dispatch must be fire-and-forget: a hanging child is the child's
      // problem, never the event loop's.
      expect(callMs).toBeLessThan(500);

      // The event loop must stay live while the child hangs.
      await new Promise((r) => setTimeout(r, 2000));
      clearInterval(heart);
      expect(heartbeats).toBeGreaterThan(40);
    },
    30_000,
  );
});
