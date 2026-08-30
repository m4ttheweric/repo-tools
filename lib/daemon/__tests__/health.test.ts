// lib/daemon/__tests__/health.test.ts
import { test, expect } from "bun:test";
import { computeHealth, type HealthInputs } from "../health.ts";

function base(): HealthInputs {
  return {
    now: 1_000_000,
    uptimeMs: 60_000,
    mem: { rss: 200 * 1024 * 1024, heapUsed: 50 * 1024 * 1024, external: 1 * 1024 * 1024 },
    rssBaseline: null,
    wsClients: 0,
    watchers: 3,
    freshness: { "remote:gitlab/acme": { state: "live" } },
    refresh: { lastSuccessAt: 1_000_000 - 60_000, failedRepos: 0, enrichErrors: 0 },
    refreshIntervalMs: 5 * 60_000,
    eventLoop: { maxLagMs: 20, lastStallAt: null, lastStallCmd: null, stalls: 0, currentlyStalled: false },
    supervisionFailuresLastHour: 0,
    crashLooping: false,
    loggerDegraded: false,
    recoveredErrorRateLastWindow: 0,
    freeBytes: 50 * 1024 * 1024 * 1024,
  };
}

test("all-nominal inputs are ok with no reasons", () => {
  const h = computeHealth(base());
  expect(h.level).toBe("ok");
  expect(h.reasons).toEqual([]);
  expect(h.metrics.watchers).toBe(3);
  expect(h.eventLoop.maxLagMs).toBe(20);
});

test("a degraded freshness watcher flips degraded and names refresh", () => {
  const i = base();
  i.freshness = { "remote:gitlab/acme": { state: "degraded" } };
  const h = computeHealth(i);
  expect(h.level).toBe("degraded");
  expect(h.reasons.some((r) => r.startsWith("refresh:"))).toBe(true);
});

test("failed repos in the last cycle flip degraded", () => {
  const i = base();
  i.refresh = { lastSuccessAt: i.now - 60_000, failedRepos: 3, enrichErrors: 5 };
  expect(computeHealth(i).level).toBe("degraded");
});

test("logger degraded flips unhealthy and names logging", () => {
  const i = base();
  i.loggerDegraded = true;
  const h = computeHealth(i);
  expect(h.level).toBe("unhealthy");
  expect(h.reasons.some((r) => r.startsWith("logging:"))).toBe(true);
});

test("currently stalled event loop is unhealthy; unhealthy wins over a degraded signal", () => {
  const i = base();
  i.eventLoop.currentlyStalled = true;
  i.freshness = { r: { state: "degraded" } }; // also degraded
  const h = computeHealth(i);
  expect(h.level).toBe("unhealthy");
  expect(h.reasons[0]?.startsWith("event-loop:")).toBe(true); // unhealthy reasons first
});

test("critical disk is unhealthy; low disk is degraded", () => {
  const crit = base(); crit.freeBytes = 50 * 1024 * 1024;
  expect(computeHealth(crit).level).toBe("unhealthy");
  const low = base(); low.freeBytes = 300 * 1024 * 1024;
  expect(computeHealth(low).level).toBe("degraded");
});

test("stale refresh (older than 2 intervals) is degraded", () => {
  const i = base();
  i.refresh = { lastSuccessAt: i.now - 11 * 60_000, failedRepos: 0, enrichErrors: 0 };
  expect(computeHealth(i).level).toBe("degraded");
});

test("event-loop lag over the named threshold flips degraded", () => {
  const i = base();
  i.eventLoop.maxLagMs = 600;
  const h = computeHealth(i);
  expect(h.level).toBe("degraded");
  expect(h.reasons.some((r) => r.startsWith("event-loop:"))).toBe(true);
});

test("event-loop lag under the named threshold stays ok", () => {
  const i = base();
  i.eventLoop.maxLagMs = 400;
  const h = computeHealth(i);
  expect(h.level).toBe("ok");
  expect(h.reasons).toEqual([]);
});
