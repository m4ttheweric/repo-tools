import { test, expect } from "bun:test";
import { applyRefreshOutcome } from "../cache-refresh.ts";

test("a clean cycle advances lastSuccessAt; a failing cycle does not", () => {
  const ref = { lastRefreshAt: 0, lastSuccessAt: 0, failedRepos: 0, enrichErrors: 0 };
  applyRefreshOutcome(ref, 1000, 0, 0);
  expect(ref.lastSuccessAt).toBe(1000);
  applyRefreshOutcome(ref, 2000, 2, 5);
  expect(ref.lastRefreshAt).toBe(2000);
  expect(ref.lastSuccessAt).toBe(1000); // unchanged on failure
  expect(ref.failedRepos).toBe(2);
});
