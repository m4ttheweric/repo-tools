/**
 * Parity guard between lib/rt-paths.ts (the authority, RT-46) and
 * packages/rt-client/src/settings/paths.ts (RT-50's deliberate duplicate —
 * rt-client cannot import rt's lib/). The rt-client module's own docblock
 * says "change [rt-paths.ts] first, mirror here"; nothing enforced that until
 * this test. A future edit to one side without the other silently splits the
 * two callers onto different store paths.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as rtPaths from "../rt-paths.ts";
import * as clientPaths from "../../packages/rt-client/src/settings/paths.ts";

describe("settings paths parity (lib/rt-paths.ts vs rt-client/settings/paths.ts)", () => {
  const origHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = origHome;
  });

  test("userSettingsPath/teamSettingsPath/machineSettingsPath/teamsDir agree under a faked HOME", () => {
    process.env.HOME = "/tmp/parity-fake-home";

    expect(clientPaths.userSettingsPath()).toBe(rtPaths.userSettingsPath());
    expect(clientPaths.teamSettingsPath("someteam")).toBe(rtPaths.teamSettingsPath("someteam"));
    expect(clientPaths.machineSettingsPath()).toBe(rtPaths.machineSettingsPath());
    expect(clientPaths.teamsDir()).toBe(rtPaths.teamsDir());
  });

  test("both resolve HOME at call time, not module load", () => {
    process.env.HOME = "/tmp/parity-home-1";
    expect(clientPaths.userSettingsPath()).toBe(join("/tmp/parity-home-1", ".mattstack", "user", "settings.user.jsonc"));

    process.env.HOME = "/tmp/parity-home-2";
    expect(clientPaths.userSettingsPath()).toBe(join("/tmp/parity-home-2", ".mattstack", "user", "settings.user.jsonc"));
    expect(clientPaths.userSettingsPath()).toBe(rtPaths.userSettingsPath());
  });

  test("machineKey agrees between both modules, override file and hostname-slug paths alike", () => {
    const home = mkdtempSync(join(tmpdir(), "parity-machine-key-"));
    process.env.HOME = home;

    // No override file: both fall through to the same hostname() slug.
    expect(clientPaths.machineKey()).toBe(rtPaths.machineKey());

    // An override file: both read the same trimmed value.
    mkdirSync(join(home, ".mattstack"), { recursive: true });
    writeFileSync(join(home, ".mattstack", "machine-key"), "  shared-override  \n");
    expect(clientPaths.machineKey()).toBe("shared-override");
    expect(clientPaths.machineKey()).toBe(rtPaths.machineKey());

    rmSync(home, { recursive: true, force: true });
  });

  test("machineSettingsPath nests under user/local/<machineKey()> on both sides", () => {
    process.env.HOME = "/tmp/parity-fake-home-2";
    expect(clientPaths.machineSettingsPath()).toBe(
      join("/tmp/parity-fake-home-2", ".mattstack", "user", "local", clientPaths.machineKey(), "settings.local.jsonc"),
    );
    expect(clientPaths.machineSettingsPath()).toBe(rtPaths.machineSettingsPath());
  });
});
