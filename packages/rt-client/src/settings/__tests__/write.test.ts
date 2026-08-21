/**
 * lib/settings/write.ts — setSetting: comment-preserving writes into the
 * user/team/machine stores, plus every refusal rule.
 *
 * Every test re-points HOME to a fresh temp dir (the resolve.test.ts /
 * stores.test.ts pattern): store files are process-global state — rt-paths
 * resolves HOME at call time — so tests must never share a tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { machineSettingsPath, teamSettingsPath, teamsDir, userSettingsPath } from "../paths.ts";
import { getDef, type SettingDef } from "../registry-machinery.ts";
import { setSetting } from "../write.ts";

const IDENTITY = "gitlab.com/assured/assured-dev";
const TEAM = "claimview";
const OTHER_TEAM = "otherteam";

describe("settings/write", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-settings-write-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  // ─── fixtures ──────────────────────────────────────────────────────────────

  function write(file: string, content: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  function seedTeam(name: string): void {
    write(teamSettingsPath(name), `// ${name} team store\n{}\n`);
  }

  function readUser(): string {
    return readFileSync(userSettingsPath(), "utf8");
  }

  function readMachine(): string {
    return readFileSync(machineSettingsPath(), "utf8");
  }

  function readTeam(name: string): string {
    return readFileSync(teamSettingsPath(name), "utf8");
  }

  // ─── creating an absent store file ─────────────────────────────────────────

  describe("seeding an absent store", () => {
    test("creates the user store with a header comment when absent", () => {
      expect(() => setSetting("rt.worktrees", { onDeck: 3 }, "user")).not.toThrow();

      const content = readUser();
      expect(content).toContain("//");
      const parsed = JSON.parse(content.replace(/^\/\/.*\n/, ""));
      expect(parsed["rt.worktrees"]).toEqual({ onDeck: 3 });
    });

    test("creates the machine store when absent", () => {
      setSetting("rt.worktrees", { onDeck: 5 }, "machine");

      const content = readMachine();
      const parsed = JSON.parse(content.replace(/^\/\/.*\n/, ""));
      expect(parsed["rt.worktrees"]).toEqual({ onDeck: 5 });
    });

    test("the header comment lands before the closing brace, not after it", () => {
      // Regression for the verified jsonc-parser footgun: modify() on a
      // comment-only file with no braces at all pushes the header AFTER the
      // closing brace. Seeding with `// header\n{}\n` first avoids it.
      setSetting("rt.worktrees", { onDeck: 3 }, "user");

      const content = readUser();
      const closeBraceIndex = content.lastIndexOf("}");
      const commentIndex = content.indexOf("//");
      expect(commentIndex).toBeGreaterThanOrEqual(0);
      expect(commentIndex).toBeLessThan(closeBraceIndex);
    });
  });

  // ─── comment preservation ───────────────────────────────────────────────────

  describe("comment preservation", () => {
    test("a comment next to an untouched key survives a write to a different key", () => {
      write(
        userSettingsPath(),
        `{\n  // do not touch this key\n  "rt.cron": { "enabled": true },\n}\n`,
      );

      setSetting("rt.worktrees", { onDeck: 3 }, "user");

      const lines = readUser().split("\n");
      expect(lines).toContain("  // do not touch this key");
    });

    test("a header comment above the object survives a write", () => {
      write(userSettingsPath(), `// user settings — safe to commit\n{}\n`);

      setSetting("rt.worktrees", { onDeck: 3 }, "user");

      const lines = readUser().split("\n");
      expect(lines).toContain("// user settings — safe to commit");
    });
  });

  // ─── repoScoped writes ──────────────────────────────────────────────────────

  describe("repoScoped writes", () => {
    test("creates the nested repos.<identity>.<key> section when absent", () => {
      setSetting("rt.roles", { backend: { pool: [3000, 3001] } }, "user", { repoIdentity: IDENTITY });

      const parsed = JSON.parse(readUser().replace(/^\/\/.*\n/, ""));
      expect(parsed.repos[IDENTITY]["rt.roles"]).toEqual({ backend: { pool: [3000, 3001] } });
    });

    test("a global-scope key written alongside a repos section leaves the repos section intact", () => {
      setSetting("rt.roles", { backend: {} }, "user", { repoIdentity: IDENTITY });
      setSetting("rt.worktrees", { onDeck: 3 }, "user");

      const parsed = JSON.parse(readUser().replace(/^\/\/.*\n/, ""));
      expect(parsed.repos[IDENTITY]["rt.roles"]).toEqual({ backend: {} });
      expect(parsed["rt.worktrees"]).toEqual({ onDeck: 3 });
    });
  });

  // ─── refusals ───────────────────────────────────────────────────────────────

  describe("refusals", () => {
    test("refuses an unregistered key", () => {
      expect(() => setSetting("rt.doesNotExist", 1, "user")).toThrow(/unknown setting|not.*registry/i);
    });

    test("refuses a scope the def does not allow", () => {
      expect(() => setSetting("rt.repoIdentityOverrides", {}, "user")).toThrow(/scope|store/i);
    });

    test("refuses a migrated:false key, naming the legacyFile", () => {
      const def = getDef("rt.hooks") as SettingDef;
      expect(() => setSetting("rt.hooks", { enabled: true }, "user")).toThrow(
        new RegExp(def.legacyFile!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    });

    test("refuses a path-literal in a pathGuardFields field at user scope", () => {
      expect(() =>
        setSetting("rt.roles", { backend: { hook: "/Users/matt/bin/dev.sh" } }, "user", {
          repoIdentity: IDENTITY,
        }),
      ).toThrow(/path literal|\$\{team|\$\{repoRoot/i);
    });

    test("refuses a home-relative path literal in a pathGuardFields field", () => {
      expect(() =>
        setSetting("rt.roles", { backend: { hook: "~/bin/dev.sh" } }, "user", { repoIdentity: IDENTITY }),
      ).toThrow(/path literal/i);
    });

    test("refuses a path-literal hook at team scope too", () => {
      seedTeam(TEAM);
      expect(() =>
        setSetting("rt.roles", { backend: { hook: "/opt/dev.sh" } }, "team", { repoIdentity: IDENTITY }),
      ).toThrow(/path literal/i);
    });

    test("machine scope is exempt from the path-literal guard", () => {
      expect(() =>
        setSetting("rt.roles", { backend: { hook: "/opt/dev.sh" } }, "machine", { repoIdentity: IDENTITY }),
      ).not.toThrow();

      const parsed = JSON.parse(readMachine().replace(/^\/\/.*\n/, ""));
      expect(parsed.repos[IDENTITY]["rt.roles"]).toEqual({ backend: { hook: "/opt/dev.sh" } });
    });

    test("refuses a team write when no team store exists", () => {
      expect(() => setSetting("rt.roles", { backend: {} }, "team", { repoIdentity: IDENTITY })).toThrow(
        /team/i,
      );
      // and it must not have silently created one
      expect(() => readFileSync(teamSettingsPath(TEAM), "utf8")).toThrow();
    });

    test("refuses a team write with an explicit opts.team whose store is missing", () => {
      seedTeam(TEAM); // a DIFFERENT team exists, but not the one asked for
      expect(() =>
        setSetting("rt.roles", { backend: {} }, "team", { repoIdentity: IDENTITY, team: "ghost-team" }),
      ).toThrow(/ghost-team/);
    });

    test("refuses an ambiguous team write when multiple team stores exist and no opts.team given", () => {
      seedTeam(TEAM);
      seedTeam(OTHER_TEAM);
      expect(() => setSetting("rt.roles", { backend: {} }, "team", { repoIdentity: IDENTITY })).toThrow(
        /multiple|ambiguous|team/i,
      );
    });
  });

  // ─── team writes ────────────────────────────────────────────────────────────

  describe("team writes", () => {
    test("writes into the single existing team store when unambiguous", () => {
      seedTeam(TEAM);

      setSetting("rt.roles", { backend: {} }, "team", { repoIdentity: IDENTITY });

      const parsed = JSON.parse(readTeam(TEAM).replace(/^\/\/.*\n/, ""));
      expect(parsed.repos[IDENTITY]["rt.roles"]).toEqual({ backend: {} });
    });

    test("writes into the team named by opts.team when multiple stores exist", () => {
      seedTeam(TEAM);
      seedTeam(OTHER_TEAM);

      setSetting("rt.roles", { backend: {} }, "team", { repoIdentity: IDENTITY, team: OTHER_TEAM });

      const parsed = JSON.parse(readTeam(OTHER_TEAM).replace(/^\/\/.*\n/, ""));
      expect(parsed.repos[IDENTITY]["rt.roles"]).toEqual({ backend: {} });
      // the other team's store must be untouched
      expect(readTeam(TEAM)).toBe(`// ${TEAM} team store\n{}\n`);
    });

    test("prints a commit+push reminder to stderr on a team write", () => {
      seedTeam(TEAM);
      const stderrWrites: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        stderrWrites.push(args.map(String).join(" "));
      };
      try {
        setSetting("rt.roles", { backend: {} }, "team", { repoIdentity: IDENTITY });
      } finally {
        console.error = orig;
      }
      expect(stderrWrites.some((line) => /commit|push/i.test(line))).toBe(true);
    });

    test("a user-scope write prints no reminder", () => {
      const stderrWrites: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        stderrWrites.push(args.map(String).join(" "));
      };
      try {
        setSetting("rt.worktrees", { onDeck: 3 }, "user");
      } finally {
        console.error = orig;
      }
      expect(stderrWrites.length).toBe(0);
    });
  });

  // ─── malformed stores refuse rather than edit around the damage ───────────

  describe("malformed store refusal", () => {
    test("refuses a duplicate top-level key, leaving the file byte-identical", () => {
      // modify() edits the FIRST occurrence by offset; every reader (parse,
      // JSON.parse) takes the LAST — so silently "fixing" this would report
      // success while the effective value never changes. Must refuse instead.
      const before = `{\n  "rt.worktrees": { "onDeck": 1 },\n  "rt.worktrees": { "onDeck": 2 }\n}\n`;
      write(userSettingsPath(), before);

      expect(() => setSetting("rt.worktrees", { onDeck: 9 }, "user")).toThrow(
        /malformed|syntax error/i,
      );
      expect(readUser()).toBe(before);
    });

    test("refuses a duplicate key nested inside the repos section", () => {
      const before = `{\n  "repos": {\n    "${IDENTITY}": { "rt.roles": {}, "rt.roles": {} }\n  }\n}\n`;
      write(userSettingsPath(), before);

      expect(() =>
        setSetting("rt.worktrees", { onDeck: 9 }, "user"),
      ).toThrow(/malformed|syntax error/i);
      expect(readUser()).toBe(before);
    });

    test("refuses a stray-brace syntax error, leaving the file byte-identical", () => {
      const before = `{ "rt.worktrees": { "onDeck": 1 } } }\n`;
      write(userSettingsPath(), before);

      expect(() => setSetting("rt.worktrees", { onDeck: 9 }, "user")).toThrow(
        /malformed|syntax error/i,
      );
      expect(readUser()).toBe(before);
    });

    test("refuses an unterminated document, leaving the file byte-identical", () => {
      const before = `{ "rt.worktrees": { "onDeck": 1 }\n`;
      write(userSettingsPath(), before);

      expect(() => setSetting("rt.worktrees", { onDeck: 9 }, "user")).toThrow(
        /malformed|syntax error/i,
      );
      expect(readUser()).toBe(before);
    });

    test("refuses a store whose root is not an object", () => {
      const before = `[1, 2, 3]\n`;
      write(userSettingsPath(), before);

      expect(() => setSetting("rt.worktrees", { onDeck: 9 }, "user")).toThrow(
        /malformed|syntax error/i,
      );
      expect(readUser()).toBe(before);
    });

    test("a malformed store leaves no .tmp remnant behind", () => {
      const before = `{ "a": 1 } }\n`;
      write(userSettingsPath(), before);

      expect(() => setSetting("rt.worktrees", { onDeck: 9 }, "user")).toThrow();

      const entries = readdirSync(dirname(userSettingsPath()));
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    });
  });

  // ─── atomic write hygiene ───────────────────────────────────────────────────

  describe("atomic write", () => {
    test("leaves no .tmp remnant after a successful write", () => {
      setSetting("rt.worktrees", { onDeck: 3 }, "user");

      const entries = readdirSync(dirname(userSettingsPath()));
      expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
      expect(entries).toContain("settings.jsonc");
    });

    test("a successful write's content matches what modify/applyEdits produced (no JSON.stringify round-trip)", () => {
      write(userSettingsPath(), `// keep this comment\n{\n  // and this one\n  "rt.cron": true,\n}\n`);

      setSetting("rt.worktrees", { onDeck: 3 }, "user");

      const content = readUser();
      expect(content).toContain("// keep this comment");
      expect(content).toContain("// and this one");
    });
  });

  // ─── sanity: teamsDir is honored ────────────────────────────────────────────

  test("uses the HOME-relative teamsDir for team store discovery", () => {
    expect(teamsDir()).toContain(home);
  });
});
