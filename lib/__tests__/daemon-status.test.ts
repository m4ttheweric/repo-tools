import { describe, expect, test } from "bun:test";
import { classifyDaemonStatus } from "../daemon-status.ts";

describe("classifyDaemonStatus", () => {
  test("not installed short-circuits everything else", () => {
    const v = classifyDaemonStatus({ installed: false, response: null, alive: false, pid: null });
    expect(v.state).toBe("not-installed");
  });

  test("an ok response is running", () => {
    const v = classifyDaemonStatus({
      installed: true,
      response: { ok: true, data: { pid: 42, uptime: 1000 } },
      alive: true,
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
      alive: false, // never consulted: the answer itself is proof of life
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
    const v = classifyDaemonStatus({ installed: true, response: null, alive: true, pid: 89290 });
    expect(v.state).toBe("degraded");
    if (v.state === "degraded") {
      expect(v.reason).toBe("unresponsive");
      expect(v.pid).toBe(89290);
    }
  });

  test("a null response and a dead ping is genuinely not running", () => {
    const v = classifyDaemonStatus({ installed: true, response: null, alive: false, pid: 123 });
    expect(v.state).toBe("not-running");
    if (v.state === "not-running") expect(v.pid).toBe(123);
  });

  test("not running without a recorded pid is still not running", () => {
    const v = classifyDaemonStatus({ installed: true, response: null, alive: false, pid: null });
    expect(v.state).toBe("not-running");
    if (v.state === "not-running") expect(v.pid).toBeNull();
  });

  test("an error response outranks a dead ping — answering is proof of life", () => {
    const v = classifyDaemonStatus({
      installed: true,
      response: { ok: false, error: "boom" },
      alive: false,
      pid: null,
    });
    expect(v.state).toBe("degraded");
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
