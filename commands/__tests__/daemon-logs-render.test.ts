/**
 * nativeStderrDisplay (showLogs' stale-crash mtime gate).
 *
 * daemon-stderr.log is rotated on daemon boot (lib/daemon-logger.ts), but a
 * leftover file can still predate the *currently running* daemon (e.g. it was
 * never rotated because the daemon has been up for days). This pins the
 * show/hide + header decision without needing a live daemon or a real file.
 */

import { describe, test, expect } from "bun:test";
import { nativeStderrDisplay } from "../daemon.ts";

const NOW = 1_785_000_000_000;

describe("nativeStderrDisplay", () => {
  test("hides the block when the file predates the daemon's startedAt", () => {
    const { show, header } = nativeStderrDisplay(NOW - 10_000, NOW);
    expect(show).toBe(false);
    expect(header).toBe("no crash since this daemon started");
  });

  test("hides the block when the file mtime exactly equals startedAt", () => {
    const { show } = nativeStderrDisplay(NOW, NOW);
    expect(show).toBe(false);
  });

  test("shows the block, with the mtime in the header, when the file postdates startedAt", () => {
    const mtimeMs = NOW + 5_000;
    const { show, header } = nativeStderrDisplay(mtimeMs, NOW);
    expect(show).toBe(true);
    expect(header).toBe(`native stderr (captured ${new Date(mtimeMs).toISOString()})`);
  });

  test("fails open (shows) when the daemon's startedAt is unknown (nothing to compare against)", () => {
    const { show } = nativeStderrDisplay(NOW - 999_999, null);
    expect(show).toBe(true);
  });
});
