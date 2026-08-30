/**
 * lib/daemon-config.ts — activeLaunchdLabel() (MAT-383 §1).
 *
 * activeLaunchdLabel() = currentMode() === "dev" ? "com.mattstack.daemon.dev" :
 * "com.mattstack.daemon". currentMode() itself is exercised in
 * lib/__tests__/dev-mode.test.ts; this test only pins the per-mode mapping,
 * driven the same way (wrapper-file presence at ~/.local/bin/rt).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { activeLaunchdLabel, resolveApiPort } from "../daemon-config.ts";
import { DEV_MODE_TAG } from "../dev-mode.ts";

const WRAPPER_PATH = join(process.env.HOME!, ".local", "bin", "rt");

describe("activeLaunchdLabel", () => {
  afterEach(() => {
    try { rmSync(WRAPPER_PATH); } catch { /* already absent */ }
  });

  test("resolves to com.mattstack.daemon in prod mode (no wrapper)", () => {
    expect(activeLaunchdLabel()).toBe("com.mattstack.daemon");
  });

  test("resolves to com.mattstack.daemon.dev in dev mode (wrapper present)", () => {
    mkdirSync(join(process.env.HOME!, ".local", "bin"), { recursive: true });
    writeFileSync(WRAPPER_PATH, `#!/bin/sh\n${DEV_MODE_TAG}\nexit 0\n`, { mode: 0o755 });
    expect(activeLaunchdLabel()).toBe("com.mattstack.daemon.dev");
  });
});

describe("resolveApiPort", () => {
  test("env wins, then setting, then 9401", () => {
    const prev = process.env.RT_API_PORT;
    process.env.RT_API_PORT = "12345";
    expect(resolveApiPort()).toBe(12345);
    delete process.env.RT_API_PORT;
    expect(resolveApiPort()).toBe(9401); // default setting value
    if (prev !== undefined) process.env.RT_API_PORT = prev;
    else delete process.env.RT_API_PORT;
  });

  // R2: RT_API_PORT="0" is a deliberate override (bind an OS-assigned
  // ephemeral port), not "unset" — `Number("0") || 9401`-style falsy checks
  // silently drop it and fall through to the setting/default instead.
  test("RT_API_PORT=0 is honored, not treated as unset", () => {
    const prev = process.env.RT_API_PORT;
    process.env.RT_API_PORT = "0";
    expect(resolveApiPort()).toBe(0);
    if (prev !== undefined) process.env.RT_API_PORT = prev;
    else delete process.env.RT_API_PORT;
  });
});
