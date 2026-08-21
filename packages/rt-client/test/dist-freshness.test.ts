/**
 * Guards against a stale or broken dist/ silently breaking `file:`
 * consumers (mr-board, gitq): those install by copying whatever dist/
 * currently holds, so `prepack` alone (npm pack/publish only) doesn't cover
 * the local dev-linking path. Rebuilding here (cheap — a few seconds) before
 * asserting turns a broken build script, not just a stale checked-in dist/,
 * into a test failure.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const pkgDir = join(import.meta.dir, "..");
const distIndexDts = join(pkgDir, "dist", "index.d.ts");

describe("dist/ freshness", () => {
  test("the build script regenerates dist/index.d.ts and it declares getSetting", () => {
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: pkgDir, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) {
      throw new Error(`bun run build failed:\n${build.stderr.toString()}`);
    }

    expect(existsSync(distIndexDts)).toBe(true);
    const contents = readFileSync(distIndexDts, "utf8");
    expect(contents).toContain("getSetting");
  });
});
