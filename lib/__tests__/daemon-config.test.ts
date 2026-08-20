/**
 * lib/daemon-config.ts — activeLaunchdLabel() (MAT-383 §1).
 *
 * activeLaunchdLabel() = currentMode() === "dev" ? "com.rt.daemon.dev" :
 * "com.rt.daemon". currentMode() itself is exercised in
 * lib/__tests__/dev-mode.test.ts; this test only pins the per-mode mapping,
 * driven the same way (wrapper-file presence at ~/.local/bin/rt).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { activeLaunchdLabel } from "../daemon-config.ts";

const WRAPPER_PATH = join(process.env.HOME!, ".local", "bin", "rt");

describe("activeLaunchdLabel", () => {
  afterEach(() => {
    try { rmSync(WRAPPER_PATH); } catch { /* already absent */ }
  });

  test("resolves to com.rt.daemon in prod mode (no wrapper)", () => {
    expect(activeLaunchdLabel()).toBe("com.rt.daemon");
  });

  test("resolves to com.rt.daemon.dev in dev mode (wrapper present)", () => {
    mkdirSync(join(process.env.HOME!, ".local", "bin"), { recursive: true });
    writeFileSync(WRAPPER_PATH, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(activeLaunchdLabel()).toBe("com.rt.daemon.dev");
  });
});
