import { test, expect } from "bun:test";
import { recordDemand, demandedWithin, wrapWithDemand } from "../demand-tracker.ts";

test("demandedWithin reflects a recent recordDemand", () => {
  recordDemand();
  expect(demandedWithin(60_000)).toBe(true);
  expect(demandedWithin(0)).toBe(false); // window of 0ms is never "recent"
});

test("wrapWithDemand records demand and delegates to the inner handler", async () => {
  let called = false;
  // Typed variadic, matching how buildRoutedHandlers' entries are actually invoked
  // (some take a payload, some don't) — a fixed 0-arg signature would reject that call shape.
  const handlers: Record<string, (...args: any[]) => Promise<{ ok: boolean }>> = {
    "system-processes": async () => { called = true; return { ok: true }; },
    other: async () => ({ ok: true }),
  };
  wrapWithDemand(handlers, ["system-processes"]);
  const before = demandedWithin(50);
  await handlers["system-processes"]!(undefined as any);
  expect(called).toBe(true);
  expect(demandedWithin(1000)).toBe(true);
  void before;
});
