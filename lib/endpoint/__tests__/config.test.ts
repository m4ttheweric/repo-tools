/**
 * lib/endpoint/config.ts — the resolver-backed endpoint reader.
 *
 * Every test re-points HOME to a fresh temp dir (the lib/settings/resolve.test.ts
 * pattern). That is load-bearing here, not hygiene: settings STORE files are
 * process-global state resolved through call-time HOME, so a store fixture
 * written by any other suite sharing the preload HOME would silently outrank
 * the legacy config.json these tests assert on.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { machineSettingsPath, repoDataDir, teamSettingsPath, teamsDir, userSettingsPath } from "../../rt-paths.ts";
import { loadEndpointConfig } from "../config.ts";

const IDENTITY = "gitlab.com/fake/endpoint-repo";
const TEAM = "acme";

describe("loadEndpointConfig", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-endpoint-config-")));
    process.env.HOME = home;
    // "warn + degrade" is the specified behaviour for an unsatisfiable
    // variable, so the spy is both the quiet-run trick and the assertion.
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  function write(file: string, obj: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
  }

  function writeRepoConfig(repo: string, obj: unknown): void {
    const dir = repoDataDir(repo);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
  }

  /** Registers `repo` → a path in repos.json, which is where `${repoRoot}` comes from. */
  function writeRepoIndex(index: Record<string, string>): void {
    write(join(home, ".mattstack", "rt", "repos.json"), index);
  }

  const legacy = (repoName: string) => loadEndpointConfig({ repoIdentity: null, repoName });

  // ─── legacy rung: the pre-migration behaviour, unchanged ───────────────────

  test("missing file yields empty config", () => {
    const cfg = legacy("no-such-repo");
    expect(cfg.roles).toEqual({});
    expect(cfg.intercepts).toEqual([]);
  });

  test("flattens ranges, sorts and dedupes pools, applies defaults", () => {
    writeRepoConfig("r1", {
      roles: { backend: { pool: [{ from: 10402, to: 10404 }, 10400, 10400] } },
    });
    const cfg = legacy("r1");
    expect(cfg.roles.backend!.pool).toEqual([10400, 10402, 10403, 10404]);
    expect(cfg.roles.backend!.needs).toEqual([]);
    expect(cfg.roles.backend!.preserveEnv).toEqual([]);
    expect(cfg.roles.backend!.env).toEqual({});
  });

  test("drops malformed entries instead of throwing", () => {
    writeRepoConfig("r2", {
      roles: { ok: { fixedPort: 4002 }, bad: "nope" },
      intercepts: [{ command: "doppler", matches: [{ cwdGlob: "apps/x/**", role: "ok" }] }, { matches: [] }],
    });
    const cfg = legacy("r2");
    expect(Object.keys(cfg.roles)).toEqual(["ok"]);
    expect(cfg.roles.ok!.fixedPort).toBe(4002);
    expect(cfg.intercepts).toHaveLength(1);
    expect(cfg.intercepts[0]!.command).toBe("doppler");
  });

  test("coexists with other keys in the same document (worktrees, setup)", () => {
    writeRepoConfig("r3", { setup: [], worktrees: { onDeck: 2 }, roles: { web: { pool: [3000] } } });
    expect(legacy("r3").roles.web!.pool).toEqual([3000]);
  });

  test("with no store files at all, a full legacy config resolves byte-identically", () => {
    const authored = {
      roles: {
        backend: {
          pool: [{ from: 10400, to: 10401 }],
          needs: ["db"],
          preserveEnv: ["POSTGRES_URL", "FEATURE_*"],
          env: { PORT: "${port}", API: "http://localhost:${roles.db.port}" },
          hook: "/Users/someone/hooks/dev.ts",
        },
        db: { fixedPort: 5432 },
      },
      intercepts: [
        {
          command: "doppler",
          matches: [
            { cwdGlob: "apps/backend{,/**}", argPattern: "src/app/server", role: "backend",
              argInject: { afterArg: "run", template: "--keep=${envKeys}", skipIfArgPresent: "--keep" } },
          ],
        },
      ],
    };
    writeRepoConfig("r-full", authored);

    // Identical to what the pre-resolver reader produced: the domain templates
    // (${port}, ${roles.*}, ${envKeys}) pass through unexpanded, and the legacy
    // file's absolute hook path is untouched (path literals are legal there).
    expect(legacy("r-full")).toEqual({
      roles: {
        backend: {
          pool: [10400, 10401],
          needs: ["db"],
          preserveEnv: ["POSTGRES_URL", "FEATURE_*"],
          env: { PORT: "${port}", API: "http://localhost:${roles.db.port}" },
          hook: "/Users/someone/hooks/dev.ts",
        },
        db: { pool: [], needs: [], preserveEnv: [], env: {}, fixedPort: 5432 },
      },
      intercepts: authored.intercepts,
    });
  });

  // ─── store rungs ───────────────────────────────────────────────────────────

  test("a team store's repo section supplies roles/intercepts, with ${team:x} expanded", () => {
    write(teamSettingsPath(TEAM), {
      repos: {
        [IDENTITY]: {
          "rt.roles": {
            backend: {
              pool: [{ from: 10400, to: 10401 }],
              env: { PORT: "${port}" },
              hook: "bun ${team:acme}/packs/acme/scripts/rt-dev-hook.ts",
            },
          },
          "rt.intercepts": [
            { command: "doppler", matches: [{ cwdGlob: "apps/backend{,/**}", role: "backend" }] },
          ],
        },
      },
    });

    const cfg = loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "unregistered-name" });
    expect(cfg.roles.backend!.pool).toEqual([10400, 10401]);
    expect(cfg.roles.backend!.env).toEqual({ PORT: "${port}" }); // domain template survives
    expect(cfg.roles.backend!.hook).toBe(
      `bun ${join(teamsDir(), TEAM)}/packs/acme/scripts/rt-dev-hook.ts`,
    );
    expect(cfg.intercepts).toEqual([
      { command: "doppler", matches: [{ cwdGlob: "apps/backend{,/**}", role: "backend" }] },
    ]);
  });

  test("a store value still goes through the sanitizers (the resolver only type-checks the top level)", () => {
    write(userSettingsPath(), {
      repos: {
        [IDENTITY]: {
          "rt.roles": { ok: { pool: [{ from: 3000, to: 3001 }, 3000] }, bad: "nope" },
          "rt.intercepts": [
            { command: "pnpm", matches: [{ cwdGlob: ".", role: "ok" }, { role: "missing-glob" }] },
            { matches: [] },
          ],
        },
      },
    });

    const cfg = loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "r-sanitize" });
    expect(Object.keys(cfg.roles)).toEqual(["ok"]);
    expect(cfg.roles.ok!.pool).toEqual([3000, 3001]);
    expect(cfg.intercepts).toHaveLength(1);
    expect(cfg.intercepts[0]!.matches).toEqual([{ cwdGlob: ".", role: "ok" }]);
  });

  test("rt.roles deep-merges across scopes; rt.intercepts replaces atomically", () => {
    writeRepoConfig("r-merge", {
      roles: { backend: { pool: [1000], preserveEnv: ["LEGACY_ONLY"] }, legacyOnly: { pool: [9000] } },
      intercepts: [{ command: "legacy-cmd", matches: [{ cwdGlob: ".", role: "legacyOnly" }] }],
    });
    write(teamSettingsPath(TEAM), {
      repos: { [IDENTITY]: { "rt.roles": { backend: { pool: [{ from: 2000, to: 2000 }] } } } },
    });
    write(userSettingsPath(), {
      repos: {
        [IDENTITY]: {
          "rt.intercepts": [{ command: "user-cmd", matches: [{ cwdGlob: ".", role: "backend" }] }],
        },
      },
    });

    const cfg = loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "r-merge" });
    expect(cfg.roles.backend!.pool).toEqual([2000]); // team wins the pool leaf
    expect(cfg.roles.backend!.preserveEnv).toEqual(["LEGACY_ONLY"]); // legacy leaf survives
    expect(cfg.roles.legacyOnly!.pool).toEqual([9000]); // legacy-only role survives
    expect(cfg.intercepts.map((i) => i.command)).toEqual(["user-cmd"]); // replace, not splice
  });

  test("${repoRoot} expands from the repo index; an unresolvable one degrades to empty, never throws", () => {
    writeRepoIndex({ "r-root": "/tmp/fake-repo-root" });
    write(machineSettingsPath(), {
      repos: {
        [IDENTITY]: { "rt.roles": { backend: { pool: [1], hook: "bun ${repoRoot}/scripts/hook.ts" } } },
      },
    });

    expect(loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "r-root" }).roles.backend!.hook)
      .toBe("bun /tmp/fake-repo-root/scripts/hook.ts");

    // Same store, a repo that is not in repos.json: ${repoRoot} cannot be
    // satisfied, so the key degrades to empty rather than taking a dev server
    // down with a half-expanded path.
    let cfg!: ReturnType<typeof loadEndpointConfig>;
    expect(() => {
      cfg = loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "not-registered" });
    }).not.toThrow();
    expect(cfg.roles).toEqual({});
    expect(warnSpy.mock.calls.flat().join(" ")).toContain("repoRoot");
  });

  test("a null identity makes repo store sections unreachable (legacy still answers)", () => {
    writeRepoConfig("r-null", { roles: { web: { pool: [3000] } } });
    write(teamSettingsPath(TEAM), {
      repos: { [IDENTITY]: { "rt.roles": { web: { pool: [{ from: 4000, to: 4000 }] } } } },
    });
    expect(loadEndpointConfig({ repoIdentity: null, repoName: "r-null" }).roles.web!.pool).toEqual([3000]);
  });
});
