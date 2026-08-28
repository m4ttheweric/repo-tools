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
