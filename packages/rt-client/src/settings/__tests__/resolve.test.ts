/**
 * lib/settings/resolve.ts — the resolver: 8-scope overlay, per-key merge,
 * teamLocked, variables, provenance.
 *
 * Every test re-points HOME to a fresh temp dir (the lib/worktree/config.test.ts
 * pattern): store files are process-global state — rt-paths resolves HOME at
 * call time — so tests must never share a tree. console.warn is spied for the
 * whole suite both to keep the run quiet and because "warn + skip" is the
 * specified behaviour for several degrades, so the spy IS the assertion.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  machineSettingsPath,
  teamSettingsPath,
  teamsDir,
  userSettingsPath,
} from "../paths.ts";
import { getDef, type SettingDef } from "../registry-machinery.ts";
import {
  expandVariables,
  explainSetting,
  getSetting,
  listSettings,
  type ExplainRow,
  type Provenance,
} from "../resolve.ts";

const IDENTITY = "gitlab.com/acme/acme-dev";
const TEAM = "acme";

describe("settings/resolve", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-settings-resolve-")));
    process.env.HOME = home;
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  // ─── fixtures ──────────────────────────────────────────────────────────────

  function write(file: string, obj: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
  }

  const writeUser = (obj: unknown) => write(userSettingsPath(), obj);
  const writeMachine = (obj: unknown) => write(machineSettingsPath(), obj);
  const writeTeam = (name: string, obj: unknown) => write(teamSettingsPath(name), obj);

  /**
   * No wave-1 key carries `teamLocked` yet, but the resolver must implement
   * the rule before the first locked key lands. The registry's defs are shared
   * objects (getDef returns the live entry), so a test can flip the flag for
   * the duration of one assertion and put it back.
   */
  function withTeamLocked(key: string, fn: () => void): void {
    const def = getDef(key) as SettingDef;
    const prev = def.teamLocked;
    def.teamLocked = true;
    try {
      fn();
    } finally {
      if (prev === undefined) delete def.teamLocked;
      else def.teamLocked = prev;
    }
  }

  // ─── precedence: the full scope ladder ─────────────────────────────────────

  describe("scope precedence", () => {
    type Layer =
      | "team"
      | "user"
      | "team.repo"
      | "user.repo"
      | "machine"
      | "machine.repo";

    // weakest → strongest, exactly the spec's ladder minus `default`
    // (rt.intercepts has no registry default; the default rung is covered by
    // its own test below with rt.worktrees).
    const LADDER: Layer[] = [
      "team",
      "user",
      "team.repo",
      "user.repo",
      "machine",
      "machine.repo",
    ];

    const marker = (layer: Layer) => [{ id: layer }];

    function fileFor(layer: Layer): string {
      if (layer === "team" || layer === "team.repo") return teamSettingsPath(TEAM);
      if (layer === "user" || layer === "user.repo") return userSettingsPath();
      return machineSettingsPath();
    }

    /** Writes all three stores so that exactly `active` layers hold a value. */
    function writeLayers(active: Layer[]): void {
      const on = (l: Layer) => active.includes(l);
      const global = (l: Layer) => (on(l) ? { "rt.intercepts": marker(l) } : {});
      const repos = (l: Layer) => (on(l) ? { [IDENTITY]: { "rt.intercepts": marker(l) } } : {});

      writeTeam(TEAM, { ...global("team"), repos: repos("team.repo") });
      writeUser({ ...global("user"), repos: repos("user.repo") });
      writeMachine({ ...global("machine"), repos: repos("machine.repo") });
    }

    test("every scope beats every weaker scope, and provenance names the winner alone", () => {
      for (let i = LADDER.length - 1; i >= 0; i--) {
        const active = LADDER.slice(0, i + 1);
        const expected = LADDER[i] as Layer;
        writeLayers(active);

        const got = getSetting<Array<{ id: string }>>("rt.intercepts", {
          repoIdentity: IDENTITY,
        });

        expect(got.value).toEqual([{ id: expected }]);
        expect(got.provenance).toEqual([{ scope: expected, file: fileFor(expected) }]);
      }
    });

    test("a replace key with nothing set anywhere resolves to undefined with empty provenance", () => {
      const got = getSetting("rt.intercepts", { repoIdentity: IDENTITY });

      expect(got.value).toBeUndefined();
      expect(got.provenance).toEqual([]);
    });

    test("the registry default is the weakest rung and carries a null file", () => {
      const got = getSetting("rt.worktrees", { repoIdentity: IDENTITY });

      expect(got.value).toEqual({ onDeck: 0 });
      expect(got.provenance).toEqual([{ scope: "default", file: null }]);
    });
  });

  // ─── deep merge ────────────────────────────────────────────────────────────

  describe("deep merge", () => {
    test("the spec proof case: team + user + machine fields all survive", () => {
      writeTeam(TEAM, {
        "rt.worktrees": { onDeck: 3, ready: [{ run: "bun install" }, { run: "bun run build" }] },
      });
      writeUser({ "rt.worktrees": { namePool: ["alpha", "bravo"] } });
      writeMachine({
        "rt.worktrees": {
          onDeck: 5,
          root: "${repoRoot}/.worktrees",
          branchFormat: "<ticket>-<slug>",
        },
      });

      const got = getSetting<Record<string, unknown>>("rt.worktrees", {
        repoIdentity: IDENTITY,
        expandCtx: { repoRoot: "/repos/acme-dev" },
      });

      expect(got.value).toEqual({
        onDeck: 5, // machine beats team beats the registry default
        root: "/repos/acme-dev/.worktrees", // machine-only field (and expands)
        branchFormat: "<ticket>-<slug>", // machine-only field survives
        namePool: ["alpha", "bravo"], // user-only field
        ready: [{ run: "bun install" }, { run: "bun run build" }], // team-only field
      });
      expect(got.provenance).toEqual([
        { scope: "team", file: teamSettingsPath(TEAM) },
        { scope: "user", file: userSettingsPath() },
        { scope: "machine", file: machineSettingsPath() },
      ]);
    });

    test("a scope whose every field was overridden is not listed as a contributor", () => {
      // The registry default {onDeck: 0} is entirely shadowed by the user store.
      writeUser({ "rt.worktrees": { onDeck: 7 } });

      const got = getSetting("rt.worktrees", { repoIdentity: IDENTITY });

      expect(got.value).toEqual({ onDeck: 7 });
      expect(got.provenance).toEqual([{ scope: "user", file: userSettingsPath() }]);
    });

    test("arrays inside a deep key replace atomically — never element-wise", () => {
      writeTeam(TEAM, { "rt.worktrees": { ready: [{ run: "team-1" }, { run: "team-2" }] } });
      writeUser({ "rt.worktrees": { ready: [{ run: "user-only" }] } });

      const got = getSetting<{ ready: unknown[] }>("rt.worktrees", {
        repoIdentity: IDENTITY,
      });

      expect(got.value.ready).toEqual([{ run: "user-only" }]);
      // team set ONLY `ready`, which user replaced whole, so team drops out
      // of provenance; the default still owns onDeck, so it stays in.
      expect(got.provenance).toEqual([
        { scope: "default", file: null },
        { scope: "user", file: userSettingsPath() },
      ]);
    });

    test("deep merge nests: a stronger scope overrides one field of one role", () => {
      writeTeam(TEAM, {
        repos: {
          [IDENTITY]: {
            "rt.roles": {
              backend: { pool: [{ from: 10400, to: 10463 }], hook: "bun team-hook.ts" },
              frontend: { pool: [{ from: 3000, to: 3010 }] },
            },
          },
        },
      });
      writeUser({
        repos: { [IDENTITY]: { "rt.roles": { backend: { pool: [{ from: 20000, to: 20010 }] } } } },
      });

      const got = getSetting<Record<string, Record<string, unknown>>>("rt.roles", {
        repoIdentity: IDENTITY,
      });

      expect(got.value).toEqual({
        backend: { pool: [{ from: 20000, to: 20010 }], hook: "bun team-hook.ts" },
        frontend: { pool: [{ from: 3000, to: 3010 }] },
      });
      expect(got.provenance).toEqual([
        { scope: "team.repo", file: teamSettingsPath(TEAM) },
        { scope: "user.repo", file: userSettingsPath() },
      ]);
    });

    test("wave 1 overlays every team alphabetically, and each team is its own provenance entry", () => {
      writeTeam("alpha", { "rt.worktrees": { onDeck: 1, namePool: ["from-alpha"] } });
      writeTeam("beta", { "rt.worktrees": { onDeck: 9 } });

      const got = getSetting("rt.worktrees", { repoIdentity: IDENTITY });

      expect(got.value).toEqual({ onDeck: 9, namePool: ["from-alpha"] });
      expect(got.provenance).toEqual([
        { scope: "team", file: teamSettingsPath("alpha") },
        { scope: "team", file: teamSettingsPath("beta") },
      ]);
    });

    test("resolution never mutates the registry default", () => {
      writeUser({ "rt.worktrees": { onDeck: 42 } });

      const first = getSetting<Record<string, unknown>>("rt.worktrees", {});
      (first.value as Record<string, unknown>).onDeck = 999;

      const second = getSetting<Record<string, unknown>>("rt.worktrees", {});
      expect(second.value.onDeck).toBe(42);
      expect(getDef("rt.worktrees")?.default).toEqual({ onDeck: 0 });
    });
  });

  // ─── teamLocked ────────────────────────────────────────────────────────────

  describe("teamLocked", () => {
    test("team wins over user and machine, which explain reports as shadowed", () => {
      writeTeam(TEAM, { "rt.intercepts": [{ id: "team" }] });
      writeUser({ "rt.intercepts": [{ id: "user" }] });
      writeMachine({ "rt.intercepts": [{ id: "machine" }] });

      withTeamLocked("rt.intercepts", () => {
        const got = getSetting("rt.intercepts", { repoIdentity: IDENTITY });
        expect(got.value).toEqual([{ id: "team" }]);
        expect(got.provenance).toEqual([{ scope: "team", file: teamSettingsPath(TEAM) }]);

        const rows = explainSetting("rt.intercepts", { repoIdentity: IDENTITY });
        const user = rows.find((r) => r.scope === "user") as ExplainRow;
        const machine = rows.find((r) => r.scope === "machine") as ExplainRow;
        expect(user.present).toBe(true);
        expect(user.value).toEqual([{ id: "user" }]);
        expect(user.shadowed).toBe("teamLocked");
        expect(machine.shadowed).toBe("teamLocked");
        expect(rows.find((r) => r.scope === "team")?.shadowed).toBeUndefined();
      });
    });

    test("team.repo still beats team for a locked key", () => {
      writeTeam(TEAM, {
        "rt.intercepts": [{ id: "team" }],
        repos: { [IDENTITY]: { "rt.intercepts": [{ id: "team.repo" }] } },
      });

      withTeamLocked("rt.intercepts", () => {
        const got = getSetting("rt.intercepts", { repoIdentity: IDENTITY });
        expect(got.value).toEqual([{ id: "team.repo" }]);
      });
    });
  });

  // ─── unknown / unregistered / invalid ──────────────────────────────────────

  describe("unknown, unregistered and invalid keys", () => {
    test("an explicit get of an unregistered key throws", () => {
      expect(() => getSetting("rt.doesNotExist")).toThrow(/unknown setting "rt\.doesNotExist"/);
    });

    test("an explicit explain of an unregistered key throws", () => {
      expect(() => explainSetting("rt.doesNotExist")).toThrow(/unknown setting/);
    });

    test("an unregistered key in a store file warns, never throws, and lists as unregistered", () => {
      writeUser({ "rt.fromANewerRt": { hello: "world" } });

      const listed = listSettings();
      const entry = listed.find((e) => e.key === "rt.fromANewerRt");

      expect(entry).toBeDefined();
      expect(entry?.unregistered).toBe(true);
      expect(entry?.migrated).toBe(false);
      expect(entry?.value).toEqual({ hello: "world" });
      expect(entry?.provenance).toEqual([{ scope: "user", file: userSettingsPath() }]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("rt.fromANewerRt"))).toBe(true);
    });

    test("a type-invalid value skips only its own scope; weaker scopes still apply", () => {
      writeTeam(TEAM, { "rt.intercepts": [{ id: "team" }] });
      writeUser({ "rt.intercepts": { not: "an array" } }); // rt.intercepts is type array

      const got = getSetting("rt.intercepts", { repoIdentity: IDENTITY });

      expect(got.value).toEqual([{ id: "team" }]);
      expect(got.provenance).toEqual([{ scope: "team", file: teamSettingsPath(TEAM) }]);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("rt.intercepts"))).toBe(true);
    });

    test("list labels the invalid scope, and explain shows the rejected value with its reason", () => {
      writeUser({ "rt.intercepts": { not: "an array" } });

      const entry = listSettings().find((e) => e.key === "rt.intercepts");
      expect(entry?.invalid).toEqual([
        { scope: "user", file: userSettingsPath(), reason: expect.stringContaining("expected array") },
      ]);

      const row = explainSetting("rt.intercepts").find((r) => r.scope === "user") as ExplainRow;
      expect(row.present).toBe(true);
      expect(row.value).toEqual({ not: "an array" });
      expect(row.invalid).toContain("expected array");
    });

    test("a shared-scope path literal on a guarded field is rejected, but the machine store may hold one", () => {
      writeTeam(TEAM, { repos: { [IDENTITY]: { "rt.roles": { be: { hook: "/abs/hook.ts" } } } } });
      writeMachine({ repos: { [IDENTITY]: { "rt.roles": { be: { hook: "/abs/machine-hook.ts" } } } } });

      const got = getSetting<Record<string, Record<string, unknown>>>("rt.roles", {
        repoIdentity: IDENTITY,
      });

      expect(got.value).toEqual({ be: { hook: "/abs/machine-hook.ts" } });
      expect(got.provenance).toEqual([{ scope: "machine.repo", file: machineSettingsPath() }]);
    });

    test("a value found in a store the def does not allow is skipped and labeled", () => {
      // rt.repoIdentityOverrides is a machine-only key.
      writeUser({ "rt.repoIdentityOverrides": { "git@host:a/b.git": "host/a/b" } });
      writeMachine({ "rt.repoIdentityOverrides": { "git@host:c/d.git": "host/c/d" } });

      const got = getSetting("rt.repoIdentityOverrides");

      expect(got.value).toEqual({ "git@host:c/d.git": "host/c/d" });
      expect(got.provenance).toEqual([{ scope: "machine", file: machineSettingsPath() }]);

      const entry = listSettings().find((e) => e.key === "rt.repoIdentityOverrides");
      expect(entry?.invalid?.[0]?.scope).toBe("user");
      expect(entry?.invalid?.[0]?.reason).toContain("machine");
    });
  });

  // ─── variables ─────────────────────────────────────────────────────────────

  describe("variables", () => {
    const ctx = () => ({ home, teamsDir: teamsDir(), repoRoot: "/repos/x", worktree: "/repos/x/.wt/a" });

    test("expands exactly the closed set", () => {
      expect(expandVariables("${home}/bin", ctx())).toBe(`${home}/bin`);
      expect(expandVariables("${team:acme}/packs", ctx())).toBe(
        `${join(teamsDir(), "acme")}/packs`,
      );
      expect(expandVariables("${repoRoot}/.worktrees", ctx())).toBe("/repos/x/.worktrees");
      expect(expandVariables("${worktree}/node_modules", ctx())).toBe("/repos/x/.wt/a/node_modules");
    });

    test("${team:<name>} is lexical — no existence check on the team dir", () => {
      expect(expandVariables("${team:never-cloned}", ctx())).toBe(join(teamsDir(), "never-cloned"));
    });

    test("${team:<name>} refuses a name that escapes the teams dir", () => {
      // join() would normalize `..` away and hand back a path OUTSIDE
      // teamsDir() — a store value that reads/execs from anywhere on disk
      // while still looking team-relative. Every traversing form throws, and
      // nothing half-expanded comes back.
      for (const name of ["../..", "../../.ssh", "a/b", "a\\b", "..", "cv/../.."]) {
        expect(() => expandVariables(`\${team:${name}}/x`, ctx())).toThrow(/single directory segment/);
      }
      // …while an ordinary name is untouched by the guard.
      expect(expandVariables("${team:claim.view-2}", ctx())).toBe(join(teamsDir(), "claim.view-2"));
    });

    test("a foreign variable passes through verbatim in the SAME string as an expanded one", () => {
      const out = expandVariables("bun ${team:acme}/hook.ts --port ${port} --keys ${envKeys}", ctx());

      expect(out).toBe(`bun ${join(teamsDir(), "acme")}/hook.ts --port \${port} --keys \${envKeys}`);
    });

    test("a closed-set variable with no context throws", () => {
      expect(() => expandVariables("${repoRoot}/x", { home, teamsDir: teamsDir() })).toThrow(
        /\$\{repoRoot\}/,
      );
      expect(() => expandVariables("${worktree}/x", { home, teamsDir: teamsDir() })).toThrow(
        /\$\{worktree\}/,
      );
    });

    test("recurses through objects and arrays, leaving non-strings alone", () => {
      const out = expandVariables(
        { a: ["${home}/one", 2, true, null], b: { c: "${home}/two" }, d: 3 },
        ctx(),
      );

      expect(out).toEqual({
        a: [`${home}/one`, 2, true, null],
        b: { c: `${home}/two` },
        d: 3,
      });
    });

    test("getSetting expands by default and throws when the closed set is unsatisfiable", () => {
      writeUser({ repos: { [IDENTITY]: { "rt.roles": { be: { hook: "bun ${team:acme}/h.ts" } } } } });

      const got = getSetting<Record<string, Record<string, string>>>("rt.roles", {
        repoIdentity: IDENTITY,
      });
      expect(got.value.be?.hook).toBe(`bun ${join(teamsDir(), "acme")}/h.ts`);

      writeUser({ repos: { [IDENTITY]: { "rt.roles": { be: { hook: "bun ${repoRoot}/h.ts" } } } } });
      expect(() => getSetting("rt.roles", { repoIdentity: IDENTITY })).toThrow(/\$\{repoRoot\}/);
    });

    test("expand:false returns the raw authored value", () => {
      writeUser({ repos: { [IDENTITY]: { "rt.roles": { be: { hook: "bun ${repoRoot}/h.ts" } } } } });

      const got = getSetting<Record<string, Record<string, string>>>("rt.roles", {
        repoIdentity: IDENTITY,
        expand: false,
      });

      expect(got.value.be?.hook).toBe("bun ${repoRoot}/h.ts");
    });

    test("explain reports values as authored, never expanded", () => {
      writeUser({ "rt.worktrees": { root: "${repoRoot}/.wt" } });

      const row = explainSetting("rt.worktrees").find((r) => r.scope === "user") as ExplainRow;

      expect(row.value).toEqual({ root: "${repoRoot}/.wt" });
    });

    test("list degrades on an unexpandable value instead of bricking the whole listing", () => {
      writeUser({ "rt.worktrees": { root: "${repoRoot}/.wt" } });

      const listed = listSettings();
      const entry = listed.find((e) => e.key === "rt.worktrees");

      expect(entry?.expandError).toMatch(/\$\{repoRoot\}/);
      expect(entry?.value).toEqual({ onDeck: 0, root: "${repoRoot}/.wt" }); // raw, not lost
      expect(listed.length).toBeGreaterThan(1); // the rest of the listing survived
    });
  });

  // ─── repo identity ─────────────────────────────────────────────────────────

  describe("repo sections", () => {
    test("a repoScoped key with a null identity skips repo sections but keeps global scopes", () => {
      writeTeam(TEAM, {
        "rt.intercepts": [{ id: "team-global" }],
        repos: { [IDENTITY]: { "rt.intercepts": [{ id: "team-repo" }] } },
      });
      writeMachine({ repos: { [IDENTITY]: { "rt.intercepts": [{ id: "machine-repo" }] } } });

      const got = getSetting("rt.intercepts", { repoIdentity: null });

      expect(got.value).toEqual([{ id: "team-global" }]);
      expect(got.provenance).toEqual([{ scope: "team", file: teamSettingsPath(TEAM) }]);
    });

    test("an omitted repoIdentity behaves like a null one", () => {
      writeUser({ repos: { [IDENTITY]: { "rt.intercepts": [{ id: "user-repo" }] } } });

      expect(getSetting("rt.intercepts").value).toBeUndefined();
    });

    test("a non-repoScoped key ignores repo sections entirely", () => {
      // rt.notifications is not repoScoped.
      writeUser({
        "rt.notifications": { pushes: true },
        repos: { [IDENTITY]: { "rt.notifications": { pushes: false } } },
      });

      const got = getSetting("rt.notifications", { repoIdentity: IDENTITY });

      expect(got.value).toEqual({ pushes: true });
      expect(got.provenance).toEqual([{ scope: "user", file: userSettingsPath() }]);
    });

    test("explain omits repo rungs when there is no identity to reach them with", () => {
      const scopes = explainSetting("rt.intercepts", { repoIdentity: null }).map((r) => r.scope);

      expect(scopes).not.toContain("team.repo");
      expect(scopes).not.toContain("user.repo");
      expect(scopes).not.toContain("machine.repo");
    });

    test("a broken entry in the teams dir never bricks resolution", () => {
      // Regression (opus review of task 4): a team clone symlinked in and later
      // moved leaves a dangling symlink under ~/.mattstack/teams, and the
      // unguarded scan behind listTeams() made EVERY resolution throw ENOENT.
      writeTeam(TEAM, { "rt.intercepts": [{ id: "team" }] });
      symlinkSync(join(home, "moved-away"), join(teamsDir(), "moved-team"));

      const got = getSetting("rt.intercepts", { repoIdentity: IDENTITY });

      expect(got.value).toEqual([{ id: "team" }]);
      expect(got.provenance).toEqual([{ scope: "team", file: teamSettingsPath(TEAM) }]);
      expect(() => listSettings({ repoIdentity: IDENTITY })).not.toThrow();
      expect(() => explainSetting("rt.intercepts", { repoIdentity: IDENTITY })).not.toThrow();
    });
  });

  // ─── listSettings / explainSetting shape ───────────────────────────────────

  describe("listSettings", () => {
    test("lists every registered def with its migrated flag, registry order first", () => {
      const listed = listSettings();

      expect(listed[0]?.key).toBe("rt.roles");
      expect(listed.find((e) => e.key === "rt.roles")?.migrated).toBe(true);
      expect(listed.find((e) => e.key === "rt.hooks")?.migrated).toBe(false);
      expect(listed.every((e) => Array.isArray(e.provenance))).toBe(true);
    });

    test("resolved values flow into the listing, with multi-scope provenance", () => {
      writeTeam(TEAM, { "rt.worktrees": { onDeck: 3, branchFormat: "x" } });
      writeUser({ "rt.worktrees": { onDeck: 5 } });

      const entry = listSettings({ repoIdentity: IDENTITY }).find((e) => e.key === "rt.worktrees");

      expect(entry?.value).toEqual({ onDeck: 5, branchFormat: "x" });
      expect(entry?.provenance).toEqual([
        { scope: "team", file: teamSettingsPath(TEAM) },
        { scope: "user", file: userSettingsPath() },
      ]);
    });

    test("unregistered entries sort after the registered ones", () => {
      writeMachine({ "rt.zzzUnknown": 1 });

      const listed = listSettings();
      const idx = listed.findIndex((e) => e.key === "rt.zzzUnknown");

      expect(idx).toBe(listed.length - 1);
      expect(listed[idx]?.unregistered).toBe(true);
    });
  });

  describe("explainSetting", () => {
    test("returns one row per reachable rung, weakest-first, with files and presence", () => {
      writeTeam(TEAM, { repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 3 } } } });

      const rows = explainSetting("rt.worktrees", { repoIdentity: IDENTITY });

      expect(rows.map((r) => r.scope)).toEqual([
        "default",
        "team",
        "user",
        "team.repo",
        "user.repo",
        "machine",
        "machine.repo",
      ]);
      expect(rows[0]).toEqual({ scope: "default", file: null, present: true, value: { onDeck: 0 } });
      const teamRepo = rows.find((r) => r.scope === "team.repo") as ExplainRow;
      expect(teamRepo.present).toBe(true);
      expect(teamRepo.file).toBe(teamSettingsPath(TEAM));
      expect(teamRepo.value).toEqual({ onDeck: 3 });
      expect(rows.find((r) => r.scope === "user")?.present).toBe(false);
    });

    test("with no team cloned at all, the team rungs are still shown as absent", () => {
      const rows = explainSetting("rt.intercepts", { repoIdentity: IDENTITY });
      const team = rows.find((r) => r.scope === "team") as ExplainRow;

      expect(team).toBeDefined();
      expect(team.present).toBe(false);
      expect(team.file).toBeNull();
    });

    test("one row per team when several are cloned", () => {
      writeTeam("alpha", { "rt.intercepts": [{ id: "a" }] });
      writeTeam("beta", {});

      const rows = explainSetting("rt.intercepts", { repoIdentity: IDENTITY });
      const teamRows = rows.filter((r) => r.scope === "team");

      expect(teamRows.map((r) => r.file)).toEqual([
        teamSettingsPath("alpha"),
        teamSettingsPath("beta"),
      ]);
      expect(teamRows[0]?.present).toBe(true);
      expect(teamRows[1]?.present).toBe(false);
    });
  });

  // ─── provenance invariant ──────────────────────────────────────────────────

  test("provenance is always an array, for every registered key, in every shape", () => {
    writeUser({ "rt.worktrees": { onDeck: 1 } });

    for (const entry of listSettings({ repoIdentity: IDENTITY })) {
      expect(Array.isArray(entry.provenance)).toBe(true);
      for (const p of entry.provenance as Provenance[]) {
        expect(typeof p.scope).toBe("string");
        expect(p.file === null || typeof p.file === "string").toBe(true);
      }
    }
  });
});
