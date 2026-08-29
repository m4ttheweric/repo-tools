// lib/daemon/__tests__/health-sampler.test.ts
import { test, expect } from "bun:test";
import { rollRssBaseline } from "../health-sampler.ts";

test("rss baseline rolls forward only after the window elapses", () => {
  // baseline null -> set on first sample
  let b = rollRssBaseline(null, { rss: 100, at: 0 }, 60 * 60_000);
  expect(b).toEqual({ rss: 100, at: 0 });
  // within the hour: unchanged
  b = rollRssBaseline(b, { rss: 200, at: 30 * 60_000 }, 60 * 60_000);
  expect(b).toEqual({ rss: 100, at: 0 });
  // after the hour: rolls to the new sample
  b = rollRssBaseline(b, { rss: 250, at: 61 * 60_000 }, 60 * 60_000);
  expect(b).toEqual({ rss: 250, at: 61 * 60_000 });
});
