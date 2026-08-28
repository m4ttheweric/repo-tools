/**
 * S022: userId used to resolve only inside reconcileFreshnessImpl's
 * live-mode-only loop, so a poll-only tracked repo (mode: "poll") never
 * built a provider, ensureUserId() never ran, getCurrentUserId() stayed
 * null forever, and checkAndNotify silently suppressed every
 * self-authored transition. Static source checks (matching this file's
 * established S048/S049 test style — see freshness-provider-rotation.test.ts —
 * since GitLabProvider is an external network client with no test seam).
 */
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const freshnessSrc = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");
const cacheRefreshSrc = readFileSync(resolve(import.meta.dir, "..", "cache-refresh.ts"), "utf8");

test("S022: a mode-independent userId resolver is exported from freshness.ts", () => {
  expect(freshnessSrc).toMatch(/export async function resolveUserIdAcrossTracking\(/);
});

test("S022: the resolver gates on the branches/project-mrs grant, not on live mode", () => {
  const fn = freshnessSrc.match(/export async function resolveUserIdAcrossTracking\([\s\S]*?\n\}\n/)?.[0];
  expect(fn).toBeTruthy();
  expect(fn).toMatch(/caches\.has\(["']branches["']\)/);
  expect(fn).toMatch(/caches\.has\(["']project-mrs["']\)/);
  expect(fn).not.toMatch(/mode\s*!==\s*["']live["']/);
});

test("S022: cache-refresh.ts resolves userId before checkAndNotify (cycle-1 fix)", () => {
  const resolveIndex = cacheRefreshSrc.indexOf("resolveUserIdAcrossTracking(");
  const checkAndNotifyIndex = cacheRefreshSrc.indexOf("checkAndNotify(cache.entries");
  expect(resolveIndex).toBeGreaterThan(-1);
  expect(checkAndNotifyIndex).toBeGreaterThan(-1);
  expect(resolveIndex).toBeLessThan(checkAndNotifyIndex);
});

test("S022: warns once when transitions are suppressed because userId never resolved", () => {
  expect(freshnessSrc).toMatch(/userId is unresolved/);
});
