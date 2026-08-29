import { test, expect } from "bun:test";
import { applyTick, newLoopStats, type LoopStats } from "../loop-monitor.ts";

const OPTS = { stallLogMs: 1000, stallUnhealthyMs: 2000, stallRecentMs: 10_000 };

test("an on-time tick records small lag and no stall", () => {
  const s = newLoopStats();
  applyTick(s, /*expected*/ 1000, /*now*/ 1010, "cache:refresh", OPTS, () => {});
  expect(s.lagMs).toBe(10);
  expect(s.maxLagMs).toBe(10);
  expect(s.stalls).toBe(0);
  expect(s.currentlyStalled).toBe(false);
});

test("a >1s drift counts a stall, records the in-flight cmd, and warns", () => {
  const s = newLoopStats();
  let warned = 0;
  applyTick(s, 1000, 2500, "mr:action", OPTS, () => { warned++; });
  expect(s.stalls).toBe(1);
  expect(s.lastStallCmd).toBe("mr:action");
  expect(s.lastStallAt).toBe(2500);
  expect(s.maxLagMs).toBe(1500);
  expect(warned).toBe(1);
});

test("currentlyStalled is true when the last big drift is within stallRecentMs", () => {
  const s = newLoopStats();
  applyTick(s, 1000, 3500, "x", OPTS, () => {}); // 2500ms drift >= 2000 unhealthy, lastStallAt=3500
  expect(s.currentlyStalled).toBe(true);
  // a small-drift tick whose `now` is past lastStallAt + stallRecentMs clears it
  // (10ms drift, so no new stall; now-lastStallAt = 10500 > 10000 recent window)
  applyTick(s, 13990, 14000, null, OPTS, () => {});
  expect(s.currentlyStalled).toBe(false);
});

test("maxLagMs is a high-water mark", () => {
  const s: LoopStats = newLoopStats();
  applyTick(s, 1000, 1300, null, OPTS, () => {});
  applyTick(s, 1550, 1600, null, OPTS, () => {});
  expect(s.maxLagMs).toBe(300);
});

test("maxLagMs decays once no bigger spike lands within the window", () => {
  const s: LoopStats = newLoopStats();
  applyTick(s, 1000, 1800, null, OPTS, () => {}); // drift 800, maxLagMs -> 800 at now=1800
  expect(s.maxLagMs).toBe(800);
  // OPTS has no maxLagWindowMs, so it falls back to stallRecentMs (10_000).
  // now=12000 is 10200ms past maxLagAt(1800), past the window, so an
  // on-time tick (drift 0) decays maxLagMs to the current lagMs.
  applyTick(s, 12000, 12000, null, OPTS, () => {});
  expect(s.maxLagMs).toBe(0);
});
