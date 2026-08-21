/**
 * rt-paths — the single source of truth for the ~/.mattstack/rt layout.
 *
 * Includes SOURCE-GUARD tests that fail the build if:
 *  - the old per-repo-at-root pattern (`join(RT_DIR, repoName, ...)`) reappears
 *    anywhere in lib/ outside this module, or
 *  - the legacy `.rt` path literal reappears anywhere under lib/, commands/,
 *    cli.ts, or packages/rt-client/src outside rt-paths.ts (RT-46: the
 *    ~/.rt compat symlink is being removed; every path must build the real
 *    ~/.mattstack/rt tree).
 * Those tripwires are the point: they keep a future relayout a one-line change
 * here instead of a scavenger hunt.
 */

import { describe, test, expect, afterEach, mock } from "bun:test";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "fs";
import * as osReal from "os";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  rtDir, reposDir, repoDataDir, logsDir,
  migrateLegacyRtDir, legacyDirsPresent,
  TRAY_APP_NAME, DEV_TRAY_APP_NAME, TRAY_APP_BUNDLE, DEV_TRAY_APP_BUNDLE,
  trayAppPath, devTrayAppPath, legacyTrayAppPaths, installedTrayAppPath, machineSettingsPath,
  machineKey, userSettingsPath, teamSettingsPath,
} from "../rt-paths.ts";

describe("rt-paths", () => {
  const origHome = process.env.HOME;
  afterEach(() => { process.env.HOME = origHome; });

  test("per-repo data dir nests under ~/.mattstack/rt/repos/<repo> at call-time HOME", () => {
    process.env.HOME = "/tmp/fake-home-abc";
    expect(rtDir()).toBe("/tmp/fake-home-abc/.mattstack/rt");
    expect(reposDir()).toBe("/tmp/fake-home-abc/.mattstack/rt/repos");
    expect(repoDataDir("my-repo")).toBe("/tmp/fake-home-abc/.mattstack/rt/repos/my-repo");
  });

  test("HOME is resolved at call time (a later change takes effect)", () => {
    process.env.HOME = "/tmp/home-1";
    expect(repoDataDir("r")).toBe("/tmp/home-1/.mattstack/rt/repos/r");
    process.env.HOME = "/tmp/home-2";
    expect(repoDataDir("r")).toBe("/tmp/home-2/.mattstack/rt/repos/r");
  });

  test("logsDir follows HOME at call time (guards against test log pollution)", () => {
    // A module-load-time const here is what made the daemon and CLI loggers
    // write into the developer's real logs dir during tests, no matter what
    // HOME the test had set.
    process.env.HOME = "/tmp/home-logs-1";
    expect(logsDir()).toBe("/tmp/home-logs-1/.mattstack/rt/logs");
    process.env.HOME = "/tmp/home-logs-2";
    expect(logsDir()).toBe("/tmp/home-logs-2/.mattstack/rt/logs");
  });

  test("log writers resolve the log dir at call time, not at module load", () => {
    // Source-guard: a writer that binds its log dir to a module-level const is
    // invisible until it silently pollutes the real tree, so pin it here.
    for (const file of ["../daemon-logger.ts", "../cli-logger.ts"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).toContain("logsDir()");
      expect(src).not.toMatch(/^const LOG_DIR\s*=/m);
    }
  });

  test("a repo dir is NEVER directly under the rt dir (regression guard for the move)", () => {
    process.env.HOME = "/tmp/h";
    expect(repoDataDir("x")).toBe(join(reposDir(), "x"));
    expect(repoDataDir("x")).not.toBe(join(rtDir(), "x"));
  });

  // ── Settings store paths (home-repo reroot) ─────────────────────────────────

  describe("settings store path shapes", () => {
    test("userSettingsPath nests under user/settings.user.jsonc", () => {
      process.env.HOME = "/tmp/fake-home-store-1";
      expect(userSettingsPath()).toBe("/tmp/fake-home-store-1/.mattstack/user/settings.user.jsonc");
    });

    test("machineSettingsPath nests under user/local/<machineKey()>/settings.local.jsonc", () => {
      const home = mkdtempSync(join(tmpdir(), "rt-paths-machine-store-"));
      process.env.HOME = home;
      expect(machineSettingsPath()).toBe(join(home, ".mattstack", "user", "local", machineKey(), "settings.local.jsonc"));
      rmSync(home, { recursive: true, force: true });
    });

    test("teamSettingsPath nests under teams/<team>/mattstack/settings.team.jsonc", () => {
      process.env.HOME = "/tmp/fake-home-store-2";
      expect(teamSettingsPath("acme")).toBe("/tmp/fake-home-store-2/.mattstack/teams/acme/mattstack/settings.team.jsonc");
    });
  });

  describe("machineKey", () => {
    const makeKeyHome = () => mkdtempSync(join(tmpdir(), "rt-paths-machine-key-"));

    afterEach(() => {
      mock.module("os", () => osReal);
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

    test("hostname slug: an all-illegal hostname slugs to empty and falls back to \"default\"", () => {
      const home = makeKeyHome();
      process.env.HOME = home;
      mock.module("os", () => ({ ...osReal, hostname: () => "!!!" }));
      expect(machineKey()).toBe("default");
      rmSync(home, { recursive: true, force: true });
    });
  });

  // ── migrateLegacyRtDir ───────────────────────────────────────────────────────

  const makeHome = () => mkdtempSync(join(tmpdir(), "rt-paths-migrate-"));

  test("migrate: no ~/.rt at all → none, nothing created", () => {
    const home = makeHome();
    process.env.HOME = home;
    expect(migrateLegacyRtDir()).toBe("none");
    expect(existsSync(join(home, ".mattstack"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("migrate: ~/.rt is a symlink → none, symlink untouched", () => {
    const home = makeHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    symlinkSync(join(home, ".mattstack", "rt"), join(home, ".rt"));
    expect(migrateLegacyRtDir()).toBe("none");
    expect(lstatSync(join(home, ".rt")).isSymbolicLink()).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("migrate: real ~/.rt, no ~/.mattstack/rt → renamed, contents intact", () => {
    const home = makeHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".rt", "repos"), { recursive: true });
    writeFileSync(join(home, ".rt", "repos.json"), "{}");
    expect(migrateLegacyRtDir()).toBe("migrated");
    expect(existsSync(join(home, ".rt"))).toBe(false);
    expect(readFileSync(join(home, ".mattstack", "rt", "repos.json"), "utf8")).toBe("{}");
    expect(statSync(join(home, ".mattstack", "rt", "repos")).isDirectory()).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("migrate: real ~/.rt AND ~/.mattstack/rt exists → conflict, both untouched", () => {
    const home = makeHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".rt"), { recursive: true });
    writeFileSync(join(home, ".rt", "old.json"), "old");
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    writeFileSync(join(home, ".mattstack", "rt", "new.json"), "new");
    expect(migrateLegacyRtDir()).toBe("conflict");
    expect(readFileSync(join(home, ".rt", "old.json"), "utf8")).toBe("old");
    expect(readFileSync(join(home, ".mattstack", "rt", "new.json"), "utf8")).toBe("new");
    rmSync(home, { recursive: true, force: true });
  });

  test("migrate is idempotent: second call after a migration is a no-op", () => {
    const home = makeHome();
    process.env.HOME = home;
    mkdirSync(join(home, ".rt"), { recursive: true });
    expect(migrateLegacyRtDir()).toBe("migrated");
    expect(migrateLegacyRtDir()).toBe("none");
    rmSync(home, { recursive: true, force: true });
  });

  // ── legacyDirsPresent (the canary probe) ────────────────────────────────────

  test("canary: reports real legacy dirs, ignores symlinks, skips absent", () => {
    const home = makeHome();
    process.env.HOME = home;

    // Nothing there at all.
    expect(legacyDirsPresent()).toEqual({ real: [], symlinks: [] });

    // ~/.rt as a symlink (compat shim) + ~/.shepherdr as a real dir.
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    symlinkSync(join(home, ".mattstack", "rt"), join(home, ".rt"));
    mkdirSync(join(home, ".shepherdr"), { recursive: true });
    expect(legacyDirsPresent()).toEqual({
      real: [join(home, ".shepherdr")],
      symlinks: [join(home, ".rt")],
    });

    // Both as real dirs.
    rmSync(join(home, ".rt"));
    mkdirSync(join(home, ".rt"), { recursive: true });
    expect(legacyDirsPresent()).toEqual({
      real: [join(home, ".rt"), join(home, ".shepherdr")],
      symlinks: [],
    });

    rmSync(home, { recursive: true, force: true });
  });

  // ── Tray app paths (MAT-383 §2) ─────────────────────────────────────────────

  test("tray app constants match the spec verbatim", () => {
    expect(TRAY_APP_NAME).toBe("mattstack");
    expect(DEV_TRAY_APP_NAME).toBe("mattstack-dev");
    expect(TRAY_APP_BUNDLE).toBe("mattstack.app");
    expect(DEV_TRAY_APP_BUNDLE).toBe("mattstack-dev.app");
  });

  test("trayAppPath resolves under ~/Applications at call-time HOME", () => {
    process.env.HOME = "/tmp/fake-home-tray-1";
    expect(trayAppPath()).toBe("/tmp/fake-home-tray-1/Applications/mattstack.app");
    process.env.HOME = "/tmp/fake-home-tray-2";
    expect(trayAppPath()).toBe("/tmp/fake-home-tray-2/Applications/mattstack.app");
  });

  test("devTrayAppPath resolves under ~/Applications at call-time HOME", () => {
    process.env.HOME = "/tmp/fake-home-dev-tray-1";
    expect(devTrayAppPath()).toBe("/tmp/fake-home-dev-tray-1/Applications/mattstack-dev.app");
    process.env.HOME = "/tmp/fake-home-dev-tray-2";
    expect(devTrayAppPath()).toBe("/tmp/fake-home-dev-tray-2/Applications/mattstack-dev.app");
  });

  test("legacyTrayAppPaths is a function (call-time HOME rule, not a const)", () => {
    // The module docblock's call-time-HOME rule forbids baking HOME at module
    // load — legacyTrayAppPaths must be callable, not a top-level array.
    expect(typeof legacyTrayAppPaths).toBe("function");
  });

  test("legacyTrayAppPaths tracks HOME at call time and includes the old ~/Applications/rt-tray.app", () => {
    process.env.HOME = "/tmp/fake-home-legacy-1";
    const first = legacyTrayAppPaths();
    expect(first).toContain("/tmp/fake-home-legacy-1/Applications/rt-tray.app");

    process.env.HOME = "/tmp/fake-home-legacy-2";
    const second = legacyTrayAppPaths();
    expect(second).toContain("/tmp/fake-home-legacy-2/Applications/rt-tray.app");
    expect(second).not.toContain("/tmp/fake-home-legacy-1/Applications/rt-tray.app");
  });

  test("legacyTrayAppPaths also carries the binary-relative candidates (mirrors verify.ts/post-install.ts)", () => {
    process.env.HOME = "/tmp/fake-home-legacy-3";
    const candidates = legacyTrayAppPaths();
    const rtExec = process.execPath;
    expect(candidates).toContain(join(rtExec, "../rt-tray.app"));
    expect(candidates).toContain(join(rtExec, "../../rt-tray.app"));
  });

  test("legacyTrayAppPaths sweeps both /Applications and ~/Applications", () => {
    process.env.HOME = "/tmp/fake-home-legacy-4";
    const candidates = legacyTrayAppPaths();
    expect(candidates).toContain("/Applications/rt-tray.app");
    expect(candidates).toContain("/tmp/fake-home-legacy-4/Applications/rt-tray.app");
  });

  // ── installedTrayAppPath (Item 5: rt hardcodes ~/Applications in four places) ──

  describe("installedTrayAppPath", () => {
    const makeHome = () => mkdtempSync(join(tmpdir(), "rt-paths-installed-tray-"));
    const bundle = "mattstack.app";

    test("the mattstack.appPath machine setting wins over both fixed locations", () => {
      const home = makeHome();
      process.env.HOME = home;
      mkdirSync(dirname(machineSettingsPath()), { recursive: true });
      writeFileSync(machineSettingsPath(), JSON.stringify({ "mattstack.appPath": "/custom/place/mattstack.app" }));

      const exists = (p: string) => p === "/custom/place/mattstack.app" || p === "/Applications/mattstack.app";
      expect(installedTrayAppPath(bundle, exists)).toBe("/custom/place/mattstack.app");

      rmSync(home, { recursive: true, force: true });
    });

    test("a machine setting naming a different bundle is never trusted for this lookup, even if it exists on disk", () => {
      const home = makeHome();
      process.env.HOME = home;
      mkdirSync(dirname(machineSettingsPath()), { recursive: true });
      // The setting names the PROD bundle; this call asks for the dev bundle.
      writeFileSync(machineSettingsPath(), JSON.stringify({ "mattstack.appPath": "/Applications/mattstack.app" }));

      const exists = (p: string) => p === "/Applications/mattstack.app" || p === join(home, "Applications", "mattstack-dev.app");
      expect(installedTrayAppPath("mattstack-dev.app", exists)).toBe(join(home, "Applications", "mattstack-dev.app"));

      rmSync(home, { recursive: true, force: true });
    });

    test("a machine setting pointing at a bundle that no longer exists is not trusted — falls through to the fixed locations", () => {
      const home = makeHome();
      process.env.HOME = home;
      mkdirSync(dirname(machineSettingsPath()), { recursive: true });
      writeFileSync(machineSettingsPath(), JSON.stringify({ "mattstack.appPath": "/gone/mattstack.app" }));

      const exists = (p: string) => p === "/Applications/mattstack.app";
      expect(installedTrayAppPath(bundle, exists)).toBe("/Applications/mattstack.app");

      rmSync(home, { recursive: true, force: true });
    });

    test("/Applications/<bundle> beats ~/Applications/<bundle> when no machine setting is present", () => {
      const home = makeHome();
      process.env.HOME = home;

      const exists = (p: string) => p === "/Applications/mattstack.app" || p === join(home, "Applications", "mattstack.app");
      expect(installedTrayAppPath(bundle, exists)).toBe("/Applications/mattstack.app");

      rmSync(home, { recursive: true, force: true });
    });

    test("falls back to ~/Applications/<bundle> when only that one exists", () => {
      const home = makeHome();
      process.env.HOME = home;

      const userPath = join(home, "Applications", "mattstack.app");
      const exists = (p: string) => p === userPath;
      expect(installedTrayAppPath(bundle, exists)).toBe(userPath);

      rmSync(home, { recursive: true, force: true });
    });

    test("null when the bundle is nowhere: no machine setting, not in /Applications, not in ~/Applications", () => {
      const home = makeHome();
      process.env.HOME = home;

      expect(installedTrayAppPath(bundle, () => false)).toBeNull();

      rmSync(home, { recursive: true, force: true });
    });
  });

  // ── Source-guards ────────────────────────────────────────────────────────────

  /** Walk .ts sources (skipping tests, node_modules, dist) under a root. */
  const walkSources = (root: string, visit: (file: string, src: string) => void) => {
    const st = statSync(root);
    if (!st.isDirectory()) {
      visit(root, readFileSync(root, "utf8"));
      return;
    }
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
        walkSources(full, visit);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      if (entry.endsWith(".test.ts")) continue;
      if (full.endsWith("/rt-paths.ts")) continue; // the one allowed home
      visit(full, readFileSync(full, "utf8"));
    }
  };

  test("no code in lib/ reconstructs <rtDir>/<repoName> by hand", () => {
    const libDir = join(import.meta.dir, "..");
    // The old per-repo-at-root shapes. Per-repo paths MUST go through
    // repoDataDir(); app-level joins use string literals and are not matched.
    const antipatterns = [
      /join\(\s*RT_DIR\s*,\s*[a-zA-Z_$]/,                       // join(RT_DIR, repoName...
      /join\(\s*homedir\(\)\s*,\s*"\.rt"\s*,\s*[a-zA-Z_$]/,     // legacy join(homedir(), <dir>, repoName)
      /["']\.rt["']\s*,\s*repoName/,                            // legacy literal, repoName
    ];
    const offenders: string[] = [];
    walkSources(libDir, (file, src) => {
      src.split("\n").forEach((line, i) => {
        if (antipatterns.some((re) => re.test(line))) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    });
    expect(offenders, `Per-repo paths must use repoDataDir() from rt-paths.ts:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("no source builds a legacy .rt path outside rt-paths.ts (RT-46)", () => {
    // The ~/.rt → ~/.mattstack/rt move (RT-33/RT-46) is complete: nothing may
    // reference the legacy tree except rt-paths.ts itself (which owns the
    // migration + canary). Catches both quoted literals (".rt") and path-like
    // occurrences in strings/comments (~/.rt/..., $HOME/.rt/...).
    const repoRoot = join(import.meta.dir, "..", "..");
    const roots = [
      join(repoRoot, "lib"),
      join(repoRoot, "commands"),
      join(repoRoot, "cli.ts"),
      join(repoRoot, "packages", "rt-client", "src"),
    ];
    const antipatterns = [
      /["'`]\.rt["'`]/,        // the quoted literal ".rt"
      /\/\.rt(\/|\b)/,         // a /.rt path segment (~/.rt/..., $HOME/.rt)
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      walkSources(root, (file, src) => {
        src.split("\n").forEach((line, i) => {
          if (antipatterns.some((re) => re.test(line))) {
            offenders.push(`${file}:${i + 1}  ${line.trim()}`);
          }
        });
      });
    }
    expect(
      offenders,
      `Legacy .rt paths must go through rt-paths.ts (rtDir() et al.):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
