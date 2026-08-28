import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

test("resolveIndexPathForIdentity no longer reaches a sync git via observedMainPath", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "repo-index.ts"), "utf8");
  // observedMainPath (sync execSync) must not be called from the async resolver path.
  expect(src).toMatch(/observedMainPathAsync/);
});
