/**
 * lib/dev-mode.ts — currentMode() parity test.
 *
 * currentMode() MOVED here from commands/settings.ts:364 (MAT-383 §1) with its
 * logic unchanged: wrapper-presence at ~/.local/bin/rt, checked via existsSync.
 * This test pins that behavior from the new home so lib/daemon-config.ts's
 * activeLaunchdLabel() (which depends on it) rests on a verified foundation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { currentMode } from "../dev-mode.ts";

// The dev-mode wrapper path is resolved at CALL time from process.env.HOME
// (mirrors lib/rt-paths.ts's home()), so this constant only needs to match
// whatever HOME is in effect when each test runs. The bun test preload
// (test-setup.ts) repoints HOME before any module loads, so this always lands
// under the per-run throwaway HOME, never the developer's real one.
const WRAPPER_PATH = join(process.env.HOME!, ".local", "bin", "rt");

describe("currentMode", () => {
  afterEach(() => {
    try { rmSync(WRAPPER_PATH); } catch { /* already absent */ }
  });

  test("reports prod when the dev-mode wrapper is absent", () => {
    expect(existsSync(WRAPPER_PATH)).toBe(false);
    expect(currentMode()).toBe("prod");
  });

  test("reports dev when the wrapper exists at ~/.local/bin/rt", () => {
    mkdirSync(join(process.env.HOME!, ".local", "bin"), { recursive: true });
    writeFileSync(WRAPPER_PATH, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(currentMode()).toBe("dev");
  });

  test("tracks HOME at call time, not at module load", () => {
    // Proves the wrapper path is recomputed on every call: a HOME that only
    // exists once currentMode() actually runs must still be honored, which
    // would be impossible if the path were baked in at module-load time.
    const realHome = process.env.HOME!;
    try {
      const fakeHome = join(realHome, ".dev-mode-call-time-probe");
      process.env.HOME = fakeHome;
      expect(currentMode()).toBe("prod"); // fakeHome/.local/bin/rt doesn't exist yet

      mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });
      writeFileSync(join(fakeHome, ".local", "bin", "rt"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(currentMode()).toBe("dev");

      rmSync(fakeHome, { recursive: true, force: true });
    } finally {
      process.env.HOME = realHome;
    }
  });
});
