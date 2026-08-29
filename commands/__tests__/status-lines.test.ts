import { test, expect } from "bun:test";
import { statusLines } from "../daemon.ts";

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

test("degraded/unresponsive prints ping-carried maxLag, not 'likely mid-sync'", () => {
  const lines = statusLines(
    { state: "degraded", reason: "unresponsive", pid: 42, eventLoop: { maxLagMs: 1400, lastStallAt: 1, lastStallCmd: "mr:action", stalls: 2 } } as any,
    2000,
  ).map(strip).join("\n");
  expect(lines).not.toContain("likely mid-sync");
  expect(lines).toContain("1400ms");
  expect(lines).toContain("mr:action");
});

test("alive-not-serving 'stalled' prints stalled Ns ago", () => {
  const lines = statusLines(
    { state: "alive-not-serving", pid: 42, detail: "stalled", stalledForMs: 8000 } as any,
    0,
  ).map(strip).join("\n");
  expect(lines).toContain("event loop stalled");
  expect(lines).toContain("8s");
});

test("running prints the health level and reasons when present", () => {
  const lines = statusLines(
    { state: "running", data: { pid: 42, uptime: 60000, watchedRepos: 3, cacheEntries: 10,
      health: { level: "degraded", reasons: ["refresh: 3 repos failing (auth?)"] } } } as any,
    0,
  ).map(strip).join("\n");
  expect(lines).toContain("degraded");
  expect(lines).toContain("refresh: 3 repos failing");
});
