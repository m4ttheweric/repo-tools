/**
 * lib/settings/stores.ts — reading the raw settings store files (jsonc-parser
 * based). Every test re-points HOME to a fresh temp dir: store files are
 * process-global state (rt-paths resolves HOME at call time), so tests must
 * not share a tree.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { userSettingsPath, teamSettingsPath, teamsDir, machineSettingsPath } from "../paths.ts";
import { readStore, listTeams } from "../stores.ts";

describe("settings/stores", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-settings-stores-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe("readStore", () => {
    test("parses JSONC with comments and splits out the repos section", () => {
      const file = userSettingsPath();
      mkdirSync(join(home, ".mattstack", "user"), { recursive: true });
      writeFileSync(
        file,
        `{
          // a global key with a trailing comment
          "rt.hooks": { "provider": "ollama", "model": "qwen3" },
          "repos": {
            "gitlab.com/assured/assured-dev": {
              "rt.roles": { "backend": { "pool": [] } },
            },
          },
        }`,
      );

      const store = readStore(file);

      expect(store.file).toBe(file);
      expect(store.exists).toBe(true);
      expect(store.global).toEqual({ "rt.hooks": { provider: "ollama", model: "qwen3" } });
      expect(store.repos).toEqual({
        "gitlab.com/assured/assured-dev": { "rt.roles": { backend: { pool: [] } } },
      });
    });

    test("global map never contains the repos key itself", () => {
      const file = machineSettingsPath();
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(file, `{ "rt.foo": 1, "repos": {} }`);

      const store = readStore(file);

      expect(Object.keys(store.global)).not.toContain("repos");
    });

    test("missing file: exists false, empty maps, no throw", () => {
      const file = userSettingsPath(); // never written

      const store = readStore(file);

      expect(store.exists).toBe(false);
      expect(store.global).toEqual({});
      expect(store.repos).toEqual({});
      expect(store.file).toBe(file);
    });

    test("malformed JSONC: exists true, empty maps, warns once", () => {
      const file = machineSettingsPath();
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(file, `{ "rt.foo": ,,, this is not json`);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const store = readStore(file);

        expect(store.exists).toBe(true);
        expect(store.global).toEqual({});
        expect(store.repos).toEqual({});
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain(file);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a present but non-object \"repos\" value warns and degrades to empty repos, but global keys still parse", () => {
      const file = machineSettingsPath();
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(file, `{ "rt.foo": 1, "repos": "not-an-object" }`);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const store = readStore(file);

        expect(store.exists).toBe(true);
        expect(store.global).toEqual({ "rt.foo": 1 }); // partial degrade, not total
        expect(store.repos).toEqual({});
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain(file);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a present but array \"repos\" value also warns and degrades", () => {
      const file = machineSettingsPath();
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(file, `{ "repos": [1, 2, 3] }`);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const store = readStore(file);

        expect(store.repos).toEqual({});
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("an absent \"repos\" key is normal — no warn, empty repos", () => {
      const file = machineSettingsPath();
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(file, `{ "rt.foo": 1 }`);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const store = readStore(file);

        expect(store.repos).toEqual({});
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a root that parses to a non-object (e.g. a bare array) is treated as malformed", () => {
      const file = machineSettingsPath();
      mkdirSync(join(home, ".mattstack"), { recursive: true });
      writeFileSync(file, `[1, 2, 3]`);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const store = readStore(file);

        expect(store.exists).toBe(true);
        expect(store.global).toEqual({});
        expect(store.repos).toEqual({});
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("an empty file parses to an empty store (not malformed)", () => {
      const file = userSettingsPath();
      mkdirSync(join(home, ".mattstack", "user"), { recursive: true });
      writeFileSync(file, "");

      const store = readStore(file);

      expect(store.exists).toBe(true);
      expect(store.global).toEqual({});
      expect(store.repos).toEqual({});
    });
  });

  describe("listTeams", () => {
    test("finds only team dirs that contain mattstack/settings.jsonc", () => {
      // claimview: has a settings file.
      mkdirSync(join(home, ".mattstack", "teams", "claimview", "mattstack"), { recursive: true });
      writeFileSync(teamSettingsPath("claimview"), "{}");

      // ghost-team: dir exists but no settings file inside — not a team yet.
      mkdirSync(join(home, ".mattstack", "teams", "ghost-team"), { recursive: true });

      // a stray file sitting directly in teamsDir() — not a directory, must be skipped.
      writeFileSync(join(teamsDir(), "not-a-team.txt"), "junk");

      expect(listTeams().sort()).toEqual(["claimview"]);
    });

    test("no teams dir at all → empty list, no throw", () => {
      expect(listTeams()).toEqual([]);
    });

    test("multiple teams are all found", () => {
      for (const team of ["alpha", "beta"]) {
        mkdirSync(join(home, ".mattstack", "teams", team, "mattstack"), { recursive: true });
        writeFileSync(teamSettingsPath(team), "{}");
      }

      expect(listTeams().sort()).toEqual(["alpha", "beta"]);
    });

    test("a symlinked team clone still counts as a team", () => {
      const real = join(home, "elsewhere", "claimview");
      mkdirSync(join(real, "mattstack"), { recursive: true });
      writeFileSync(join(real, "mattstack", "settings.jsonc"), "{}");
      mkdirSync(teamsDir(), { recursive: true });
      symlinkSync(real, join(teamsDir(), "claimview"));

      expect(listTeams()).toEqual(["claimview"]);
    });

    test("a DANGLING symlink is skipped with a warn — healthy teams still list", () => {
      // The realistic trigger: a team clone symlinked in and later moved. The
      // follow-the-link stat throws ENOENT, and listTeams is on the path of
      // every settings resolution — so it must skip, not throw.
      mkdirSync(join(home, ".mattstack", "teams", "claimview", "mattstack"), { recursive: true });
      writeFileSync(teamSettingsPath("claimview"), "{}");
      symlinkSync(join(home, "moved-away"), join(teamsDir(), "moved-team"));
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        expect(listTeams()).toEqual(["claimview"]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain("moved-team");
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("an unreadable teams dir → empty list, warn, no throw", () => {
      const dir = teamsDir();
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o000);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

      try {
        expect(listTeams()).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain(dir);
      } finally {
        warnSpy.mockRestore();
        chmodSync(dir, 0o755); // so afterEach can remove the temp HOME
      }
    });
  });
});
