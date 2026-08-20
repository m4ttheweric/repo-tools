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

// DEV_MODE_WRAPPER is computed once, at module-load time, from Bun.env.HOME
// (matching the pre-move behavior in commands/settings.ts — logic unchanged
// means this stays module-load-time, not call-time). The bun test preload
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
});
