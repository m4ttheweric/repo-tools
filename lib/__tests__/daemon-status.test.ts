import { describe, expect, test } from "bun:test";
import { classifyDaemonStatus } from "../daemon-status.ts";
import type { BootFailure, LastExit, SupervisionState } from "../daemon/supervision-state.ts";

// `alive` (Task 1's field name for "a plain ping succeeded") is renamed
// `pingOk` here: Task 10 adds a second, distinct liveness signal (`pidAlive`,
// a raw OS-level pid check independent of rt.sock), and keeping both named
// `alive` would make call sites ambiguous about which one they mean.
function emptySupervision(): SupervisionState {
  return { bootAttempts: 0, lastReadyAt: 0, recentFailures: [], lastExit: null };
}

function oneFailure(phase: BootFailure["phase"], reason: string): BootFailure {
  return { at: Date.now(), phase, reason };
}

function threeRecentFailures(): BootFailure[] {
  const now = Date.now();
  return [
    { at: now - 3000, phase: "api", reason: "EADDRINUSE" },
    { at: now - 2000, phase: "api", reason: "EADDRINUSE" },
    { at: now - 1000, phase: "api", reason: "EADDRINUSE" },
  ];
}

function bootFailedExit(reason: string): LastExit {
  return { at: Date.now(), kind: "boot-failed", code: 1, reason };
}

describe("classifyDaemonStatus", () => {
  test("not installed short-circuits everything else", () => {
    const v = classifyDaemonStatus({ installed: false, response: null, pingOk: false, pid: null });
    expect(v.state).toBe("not-installed");
  });

  test("an ok response is running", () => {
    const v = classifyDaemonStatus({
      installed: true,
      response: { ok: true, data: { pid: 42, uptime: 1000 } },
      pingOk: true,
      pid: 42,
    });
    expect(v.state).toBe("running");
    if (v.state === "running") expect(v.data.pid).toBe(42);
  });

  // The bug: the daemon ANSWERED, which proves it is up, but the old code
  // read `!response.ok` as "not running" and discarded the error text.
  test("an error response means running — the status command failed, not the daemon", () => {
    const v = classifyDaemonStatus({
      installed: true,
      response: { ok: false, error: "freshness store unreadable" },
      pingOk: false, // never consulted: the answer itself is proof of life
      pid: 89290,
    });
    expect(v.state).toBe("degraded");
    if (v.state === "degraded") {
      expect(v.reason).toBe("error");
      expect(v.detail).toBe("freshness store unreadable");
    }
  });

  // The other half of the bug: daemonQuery returns null on a 2s timeout even
  // when it has already established the socket is live (daemon-client.ts:149).
  test("a null response with a live ping means running but unresponsive", () => {
    const v = classifyDaemonStatus({ installed: true, response: null, pingOk: true, pid: 89290 });
    expect(v.state).toBe("degraded");
    if (v.state === "degraded") {
      expect(v.reason).toBe("unresponsive");
      expect(v.pid).toBe(89290);
    }
  });

  test("a null response and a dead ping is genuinely not running", () => {
    const v = classifyDaemonStatus({ installed: true, response: null, pingOk: false, pid: 123 });
    expect(v.state).toBe("not-running");
    if (v.state === "not-running") expect(v.pid).toBe(123);
  });

  test("not running without a recorded pid is still not running", () => {
    const v = classifyDaemonStatus({ installed: true, response: null, pingOk: false, pid: null });
    expect(v.state).toBe("not-running");
    if (v.state === "not-running") expect(v.pid).toBeNull();
  });

  test("an error response outranks a dead ping — answering is proof of life", () => {
    const v = classifyDaemonStatus({
      installed: true,
      response: { ok: false, error: "boom" },
      pingOk: false,
      pid: null,
    });
    expect(v.state).toBe("degraded");
  });

  // ── Task 10: alive-not-serving / parked / crash-looping / boot-failed ──

  test("alive pid + failed ping -> alive-not-serving with breadcrumb detail", () => {
    const v = classifyDaemonStatus({
      installed: true,
      pingOk: false,
      pidAlive: true,
      pid: 42,
      breadcrumb: { phase: "socket" },
      supervision: emptySupervision(),
    });
    expect(v).toMatchObject({ state: "alive-not-serving", pid: 42, detail: "booting" });
  });

  test("alive pid stuck after reaching ready -> wedged", () => {
    const v = classifyDaemonStatus({
      installed: true,
      pingOk: false,
      pidAlive: true,
      pid: 42,
      breadcrumb: { phase: "ready" },
      supervision: emptySupervision(),
    });
    expect(v).toMatchObject({ state: "alive-not-serving", pid: 42, detail: "wedged" });
  });

  test("alive pid at ready with a boot-failed exit on record -> quarantined", () => {
    const v = classifyDaemonStatus({
      installed: true,
      pingOk: false,
      pidAlive: true,
      pid: 42,
      breadcrumb: { phase: "ready" },
      supervision: { ...emptySupervision(), lastExit: bootFailedExit("events.db corrupt") },
    });
    expect(v).toMatchObject({ state: "alive-not-serving", pid: 42, detail: "quarantined" });
  });

  test("alive pid whose breadcrumb flavor disagrees with the intended flavor -> parked", () => {
    const v = classifyDaemonStatus({
      installed: true,
      pingOk: false,
      pidAlive: true,
      pid: 42,
      intendedFlavor: "prod",
      breadcrumb: { phase: "start", flavor: "dev" },
      supervision: emptySupervision(),
    });
    expect(v).toMatchObject({ state: "parked", pid: 42 });
  });

  test("a breadcrumb with no supervision (pre-state.db failure) still classifies from the file alone", () => {
    const v = classifyDaemonStatus({
      installed: true,
      pingOk: false,
      pidAlive: true,
      pid: 42,
      breadcrumb: { phase: "events-db" },
    });
    expect(v).toMatchObject({ state: "alive-not-serving", pid: 42, detail: "booting" });
  });

  test("no pid + >=3 recent failures -> crash-looping", () => {
    const v = classifyDaemonStatus({
      installed: true,
      pingOk: false,
      pidAlive: false,
      pid: null,
      supervision: { ...emptySupervision(), recentFailures: threeRecentFailures(), lastExit: bootFailedExit("EADDRINUSE") },
    });
    expect(v).toMatchObject({ state: "crash-looping" });
    if (v.state === "crash-looping") {
      expect(v.failures).toBeGreaterThanOrEqual(3);
      expect(v.reason).toBe("EADDRINUSE");
    }
  });

  test("no pid + single boot-failed -> boot-failed with reason and phase", () => {
    const v = classifyDaemonStatus({
      installed: true,
      pingOk: false,
      pidAlive: false,
      pid: null,
      supervision: { ...emptySupervision(), recentFailures: [oneFailure("api", "EADDRINUSE")], lastExit: bootFailedExit("EADDRINUSE") },
    });
    expect(v).toMatchObject({ state: "boot-failed", reason: "EADDRINUSE", phase: "api" });
  });

  test("no pid + no supervision at all -> plain not-running (additive: old callers unaffected)", () => {
    const v = classifyDaemonStatus({ installed: true, pingOk: false, pidAlive: false, pid: null });
    expect(v.state).toBe("not-running");
  });
});

describe("needsLivenessProbe", () => {
  test("only a null response needs the extra ping round-trip", () => {
    expect(classifyDaemonStatus.needsLivenessProbe(null)).toBe(true);
  });

  test("any answer — ok or not — makes the probe redundant", () => {
    expect(classifyDaemonStatus.needsLivenessProbe({ ok: true, data: {} })).toBe(false);
    expect(classifyDaemonStatus.needsLivenessProbe({ ok: false, error: "x" })).toBe(false);
  });
});
