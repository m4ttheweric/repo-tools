import { test, expect } from "bun:test";
import { makeCoalescer } from "../cache-refresh.ts";

test("clears the in-flight latch after the deadline even if run never settles", async () => {
  let starts = 0;
  let timedOut = 0;
  const coalesce = makeCoalescer(
    () => { starts++; return new Promise<void>(() => {}); }, // never resolves
    50,
    () => { timedOut++; },
  );
  const t0 = Date.now();
  await coalesce();               // resolves at the deadline, not never
  expect(Date.now() - t0).toBeLessThan(500);
  expect(timedOut).toBe(1);
  await coalesce();               // latch cleared, a new run can start
  expect(starts).toBe(2);
});

test("coalesces concurrent callers onto one run", async () => {
  let starts = 0;
  let resolveRun!: () => void;
  const coalesce = makeCoalescer(
    () => { starts++; return new Promise<void>((r) => { resolveRun = r; }); },
    10_000,
    () => {},
  );
  const a = coalesce();
  const b = coalesce();
  expect(starts).toBe(1);
  resolveRun();
  await Promise.all([a, b]);
});
