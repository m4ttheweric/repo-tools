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

test("a fast success does not fire onTimeout after the deadline elapses", async () => {
  let timedOut = 0;
  const coalesce = makeCoalescer(
    () => Promise.resolve(), // settles well before the deadline
    50,
    () => { timedOut++; },
  );
  await coalesce();
  await new Promise((r) => setTimeout(r, 150)); // past the deadline
  expect(timedOut).toBe(0); // the deadline timer must have been cleared, not just outraced
});

test("refuses to admit a replacement cycle once maxOrphanCycles stalled runs are already stuck in the background", async () => {
  let starts = 0;
  let refused = 0;
  const coalesce = makeCoalescer(
    () => { starts++; return new Promise<void>(() => {}); }, // never resolves — every cycle orphans
    10,
    () => {},
    { maxOrphanCycles: 2, onRefused: () => { refused++; } },
  );
  await coalesce(); // orphans (1)
  await coalesce(); // orphans (2)
  await coalesce(); // cap hit — refused, no new socket work started
  expect(starts).toBe(2);
  expect(refused).toBe(1);
});
