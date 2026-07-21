import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cleanGenerated } from "../lib/docs-clean.ts";
import { HAND_WRITTEN_REFERENCE } from "../lib/docs-hand.ts";

test("cleanGenerated removes generated pages but preserves the hand-written allowlist", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-clean-"));
  try {
    // generated artifacts that should be removed
    writeFileSync(join(dir, "run.mdx"), "gen");
    mkdirSync(join(dir, "git"), { recursive: true });
    writeFileSync(join(dir, "git", "index.mdx"), "gen");
    // hand-written artifacts that must survive
    writeFileSync(join(dir, "_category_.json"), "{}");
    writeFileSync(join(dir, "global.mdx"), "hand");
    mkdirSync(join(dir, "_partials"), { recursive: true });
    writeFileSync(join(dir, "_partials", "run.mdx"), "hand");

    cleanGenerated(dir, HAND_WRITTEN_REFERENCE);

    expect(existsSync(join(dir, "run.mdx"))).toBe(false);
    expect(existsSync(join(dir, "git"))).toBe(false);
    expect(existsSync(join(dir, "_category_.json"))).toBe(true);
    expect(existsSync(join(dir, "global.mdx"))).toBe(true);
    expect(existsSync(join(dir, "_partials", "run.mdx"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanGenerated is a no-op when the dir does not exist", () => {
  const dir = join(tmpdir(), "rt-clean-missing-" + process.pid);
  expect(() => cleanGenerated(dir, HAND_WRITTEN_REFERENCE)).not.toThrow();
});
