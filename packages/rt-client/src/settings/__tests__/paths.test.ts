/**
 * packages/rt-client/src/settings/paths.ts — the rt-client mirror of
 * lib/rt-paths.ts's settings-store constructors (see that module's docblock
 * for the "change there first, mirror here" convention). Parity between the
 * two is covered separately by lib/__tests__/settings-paths-parity.test.ts;
 * this file exercises the rt-client side's own behavior in isolation.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as osReal from "os";
import { tmpdir } from "os";
import { join } from "path";
import { machineKey, machineSettingsPath, teamSettingsPath, teamsDir, userSettingsPath } from "../paths.ts";

// `mock.module` mutates the live "os" namespace object in place, so
// `osReal.hostname` itself becomes the mock the moment it's installed —
// restoring with `() => osReal` would restore the mock to itself. Capture
// the real function BEFORE any test can call mock.module("os", ...).
const realHostname = osReal.hostname;

describe("settings/paths", () => {
  const origHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = origHome;
  });

  describe("path shapes", () => {
    test("userSettingsPath nests under user/settings.user.jsonc", () => {
      process.env.HOME = "/tmp/fake-home-client-1";
      expect(userSettingsPath()).toBe("/tmp/fake-home-client-1/.mattstack/user/settings.user.jsonc");
    });

    test("machineSettingsPath nests under user/local/<machineKey()>/settings.local.jsonc", () => {
      const home = mkdtempSync(join(tmpdir(), "rt-client-machine-store-"));
      process.env.HOME = home;
      expect(machineSettingsPath()).toBe(join(home, ".mattstack", "user", "local", machineKey(), "settings.local.jsonc"));
      rmSync(home, { recursive: true, force: true });
    });

    test("teamSettingsPath nests under teams/<team>/mattstack/settings.team.jsonc", () => {
      process.env.HOME = "/tmp/fake-home-client-2";
      expect(teamSettingsPath("acme")).toBe("/tmp/fake-home-client-2/.mattstack/teams/acme/mattstack/settings.team.jsonc");
    });

    test("teamsDir resolves at call-time HOME", () => {
      process.env.HOME = "/tmp/fake-home-client-3";
      expect(teamsDir()).toBe("/tmp/fake-home-client-3/.mattstack/teams");
    });
  });

  describe("machineKey", () => {
    const makeKeyHome = () => mkdtempSync(join(tmpdir(), "rt-client-machine-key-"));

    afterEach(() => {
      mock.module("os", () => ({ ...osReal, hostname: realHostname }));
    });

    test("an override file wins, trimmed", () => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(join(home, ".mattstack", "machine-key"), "  my-custom-key  \n");
      expect(machineKey()).toBe("my-custom-key");
      rmSync(home, { recursive: true, force: true });
    });

    test("an override file that is empty after trim falls through to the hostname slug", () => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(join(home, ".mattstack", "machine-key"), "   \n");
      mock.module("os", () => ({ ...osReal, hostname: () => "Real-Host" }));
      expect(machineKey()).toBe("real-host");
      rmSync(home, { recursive: true, force: true });
    });

    // An override becomes a directory name directly under user/local/, so a
    // value that isn't a safe single path segment must not be honored — it
    // would escape that directory (a separator) or resolve to a no-op/parent
    // segment (".", "..") instead of a distinct machine's namespace.
    test.each([
      ["a forward slash", "evil/key"],
      ["a backslash", "evil\\key"],
      ["exactly \".\"", "."],
      ["exactly \"..\"", ".."],
    ])("an override value containing %s is rejected — falls through to the hostname slug", (_label, unsafe) => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(join(home, ".mattstack", "machine-key"), unsafe);
      mock.module("os", () => ({ ...osReal, hostname: () => "Safe-Host" }));
      expect(machineKey()).toBe("safe-host");
      rmSync(home, { recursive: true, force: true });
    });

    test("no override file at all: falls through to the hostname slug", () => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mock.module("os", () => ({ ...osReal, hostname: () => "Some-Host" }));
      expect(machineKey()).toBe("some-host");
      rmSync(home, { recursive: true, force: true });
    });

    test("hostname slug: lowercased, trailing .local stripped", () => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mock.module("os", () => ({ ...osReal, hostname: () => "Matts-MacBook-Pro.local" }));
      expect(machineKey()).toBe("matts-macbook-pro");
      rmSync(home, { recursive: true, force: true });
    });

    test("hostname slug: illegal characters collapse to single dashes, edges trimmed", () => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mock.module("os", () => ({ ...osReal, hostname: () => "  weird_host!!name@@ " }));
      expect(machineKey()).toBe("weird-host-name");
      rmSync(home, { recursive: true, force: true });
    });

    test('hostname slug: an all-illegal hostname slugs to empty and falls back to "default"', () => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mock.module("os", () => ({ ...osReal, hostname: () => "!!!" }));
      expect(machineKey()).toBe("default");
      rmSync(home, { recursive: true, force: true });
    });
  });
});
