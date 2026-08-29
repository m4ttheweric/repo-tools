import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

test("freshness.ts no longer imports execSync/child_process", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");
  expect(src).not.toMatch(/from\s+["']child_process["']/);
  expect(src).not.toMatch(/\bexecSync\b/);
});
