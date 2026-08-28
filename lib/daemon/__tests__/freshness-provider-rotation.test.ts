import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

test("ensureProvider compares the current token before reusing a cached provider", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");
  // The unconditional cache-hit return is the S049 bug; it must be gone.
  expect(src).not.toMatch(/const cached = providers\.get\(repoName\);\s*\n\s*if \(cached\) return cached;/);
  // A token fingerprint must be stored alongside the provider.
  expect(src).toMatch(/providers\.set\(repoName,\s*\{\s*provider/);
});

test("getRepoContext drops a stale-token provider before serving the cached one (S048/S049 fix 1)", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");
  const tokenCheckMatch = src.match(/cachedForToken\.token !== currentSecrets\.gitlabToken/);
  expect(tokenCheckMatch).not.toBeNull();
  // The comparison must run before the cache is read for the fast path, so a
  // rotated token can never reach a poll-mode repo or an already-cached
  // forge-handler provider.
  const fastPathIndex = src.indexOf("const watch = watches.get(repoName);");
  expect(fastPathIndex).toBeGreaterThan(-1);
  expect(tokenCheckMatch!.index!).toBeLessThan(fastPathIndex);
});

test("reconcileFreshnessImpl drops a stale-token watch before skipping already-watched repos (S048/S049 fix 2)", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");
  const staleWatchDrop = src.match(/existing\.token !== secrets\.gitlabToken\)\s*stopWatch\(repoName\);/);
  expect(staleWatchDrop).not.toBeNull();
  // The drop must happen before the "already watched, skip" short-circuit,
  // or a live watcher built on a rotated token never rebuilds.
  const skipIndex = src.indexOf("if (watches.has(repoName)) continue;");
  expect(skipIndex).toBeGreaterThan(-1);
  expect(staleWatchDrop!.index!).toBeLessThan(skipIndex);
});
