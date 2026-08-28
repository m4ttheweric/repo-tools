/**
 * statusLines rendering.
 *
 * The classifier is covered in lib/__tests__/daemon-status.test.ts; this pins
 * the text the operator actually reads — that a live-but-unreporting daemon is
 * never described as "not running", and is never told to start a second one.
 */

import { describe, expect, test } from "bun:test";
import { statusLines } from "../daemon.ts";
import type { DaemonStatusVerdict } from "../../lib/daemon-status.ts";

const NOW = 1_785_000_000_000;
const plain = (v: DaemonStatusVerdict) => statusLines(v, NOW).join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("statusLines", () => {
  test("a daemon that answered with an error reads as running, and shows the error", () => {
    const out = plain({ state: "degraded", reason: "error", detail: "freshness store unreadable", pid: 89290 });
    expect(out).toContain("running, but not reporting status");
    expect(out).toContain("freshness store unreadable");
    expect(out).toContain("pid: 89290");
    // The regression: never claim it is down, never send them to `start`.
    expect(out).not.toContain("installed but not running");
    expect(out).not.toContain("rt daemon start");
  });

  test("a timed-out status on a pingable daemon reads as running", () => {
    const out = plain({ state: "degraded", reason: "unresponsive", pid: 89290 });
    expect(out).toContain("running, but not reporting status");
    expect(out).toContain("status timed out");
    expect(out).not.toContain("installed but not running");
    expect(out).not.toContain("rt daemon start");
  });

  test("a genuinely dead daemon still reads as not running, with how to start it", () => {
    const out = plain({ state: "not-running", pid: 89290 });
    expect(out).toContain("installed but not running");
    expect(out).toContain("last pid: 89290");
    expect(out).toContain("rt daemon start");
  });

  test("a healthy daemon renders the normal running line", () => {
    const out = plain({
      state: "running",
      data: { pid: 75462, uptime: 60_000, watchedRepos: 22, cacheEntries: 477 },
    });
    expect(out).toContain("pid 75462");
    expect(out).toContain("watching: 22 repos");
    expect(out).toContain("cache: 477 entries");
    expect(out).not.toContain("not reporting status");
  });

  test("freshness ages render against the injected clock", () => {
    const out = plain({
      state: "running",
      data: {
        pid: 1, uptime: 1000, watchedRepos: 1, cacheEntries: 0,
        freshness: {
          "acme-dev": { state: "live", lastSyncedAt: new Date(NOW - 82_000).toISOString() },
          "quiet-repo": { state: "live", lastSyncedAt: null },
        },
      },
    });
    expect(out).toContain("acme-dev live (82s ago)");
    // A quiet-but-healthy repo must not read as broken.
    expect(out).toContain("quiet-repo live (no events yet)");
  });

  test("a single watched repo is not pluralised", () => {
    const out = plain({ state: "running", data: { pid: 1, uptime: 1000, watchedRepos: 1, cacheEntries: 0 } });
    expect(out).toContain("watching: 1 repo");
    expect(out).not.toContain("1 repos");
  });

  // ── Task 10 ──

  test("a parked pid points at the flavor mismatch, not 'not running'", () => {
    const out = plain({ state: "parked", pid: 42, holderFlavor: "prod" });
    expect(out).toContain("parked");
    expect(out).toContain("pid 42");
    expect(out).toContain("held by: prod");
    expect(out).not.toContain("installed but not running");
  });

  test("alive-not-serving names the pid and the stuck detail", () => {
    const out = plain({ state: "alive-not-serving", pid: 42, detail: "booting" });
    expect(out).toContain("process 42 is running but not answering rt.sock");
    expect(out).toContain("still booting");
    expect(out).not.toContain("installed but not running");
  });

  test("alive-not-serving wedged/quarantined get their own detail lines", () => {
    expect(plain({ state: "alive-not-serving", pid: 1, detail: "wedged" })).toContain("deadlocked");
    expect(plain({ state: "alive-not-serving", pid: 1, detail: "quarantined" })).toContain("recovered from a corrupt db");
  });

  test("crash-looping surfaces the failure count and the last reason", () => {
    const out = plain({ state: "crash-looping", failures: 4, reason: "EADDRINUSE" });
    expect(out).toContain("crash-looping");
    expect(out).toContain("4 failures");
    expect(out).toContain("EADDRINUSE");
  });

  test("boot-failed surfaces the phase and reason, and points at rt daemon start", () => {
    const out = plain({ state: "boot-failed", reason: "EADDRINUSE", phase: "api" });
    expect(out).toContain("boot failed");
    expect(out).toContain("phase: api");
    expect(out).toContain("EADDRINUSE");
    expect(out).toContain("rt daemon start");
  });
});
