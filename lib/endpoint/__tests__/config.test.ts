/**
 * lib/endpoint/config.ts — the resolver-backed endpoint reader.
 *
 * Every test re-points HOME to a fresh temp dir (the lib/settings/resolve.test.ts
 * pattern): settings STORE files are process-global state resolved through
 * call-time HOME, so a store fixture written by any other suite sharing the
 * preload HOME would silently outrank these tests' own fixtures.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { machineSettingsPath, teamSettingsPath, teamsDir, userSettingsPath } from "../../rt-paths.ts";
import { closeStateDb, setKvValue } from "../../state/index.ts";
import { loadEndpointConfig } from "../config.ts";

const IDENTITY = "gitlab.com/fake/endpoint-repo";
const TEAM = "claimview";

describe("loadEndpointConfig", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-endpoint-config-")));
    process.env.HOME = home;
    closeStateDb();
    // "warn + degrade" is the specified behaviour for an unsatisfiable
    // variable, so the spy is both the quiet-run trick and the assertion.
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  function write(file: string, obj: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
  }

  /** Registers `repo` → a path in the repo-index store, which is where `${repoRoot}` comes from. */
  function writeRepoIndex(index: Record<string, string>): void {
    for (const [repoName, repoPath] of Object.entries(index)) {
      setKvValue("repo-index", repoName, repoPath);
    }
  }

  test("missing everything yields empty config", () => {
    const cfg = loadEndpointConfig({ repoIdentity: null, repoName: "no-such-repo" });
    expect(cfg.roles).toEqual({});
    expect(cfg.intercepts).toEqual([]);
  });

  test("flattens ranges, sorts and dedupes pools, applies defaults", () => {
    write(machineSettingsPath(), {
      repos: { [IDENTITY]: { "rt.roles": { backend: { pool: [{ from: 10402, to: 10404 }, 10400, 10400] } } } },
    });
    const cfg = loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "r1" });
    expect(cfg.roles.backend!.pool).toEqual([10400, 10402, 10403, 10404]);
    expect(cfg.roles.backend!.needs).toEqual([]);
    expect(cfg.roles.backend!.preserveEnv).toEqual([]);
    expect(cfg.roles.backend!.env).toEqual({});
  });

  test("drops malformed entries instead of throwing", () => {
    write(machineSettingsPath(), {
      repos: {
        [IDENTITY]: {
          "rt.roles": { ok: { fixedPort: 4002 }, bad: "nope" },
          "rt.intercepts": [{ command: "doppler", matches: [{ cwdGlob: "apps/x/**", role: "ok" }] }, { matches: [] }],
        },
      },
    });
    const cfg = loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "r2" });
    expect(Object.keys(cfg.roles)).toEqual(["ok"]);
    expect(cfg.roles.ok!.fixedPort).toBe(4002);
    expect(cfg.intercepts).toHaveLength(1);
    expect(cfg.intercepts[0]!.command).toBe("doppler");
  });

  test("with a full store block, resolves byte-identically to the authored shape", () => {
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
    write(machineSettingsPath(), {
      repos: { [IDENTITY]: { "rt.roles": authored.roles, "rt.intercepts": authored.intercepts } },
    });

    // The domain templates (${port}, ${roles.*}, ${envKeys}) pass through
    // unexpanded, and the machine store's absolute hook path is untouched
    // (path literals are legal there).
    expect(loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "r-full" })).toEqual({
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
              hook: "bun ${team:claimview}/packs/claimview/scripts/rt-dev-hook.ts",
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
      `bun ${join(teamsDir(), TEAM)}/packs/claimview/scripts/rt-dev-hook.ts`,
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
    write(teamSettingsPath(TEAM), {
      repos: {
        [IDENTITY]: {
          "rt.roles": { backend: { pool: [1000], preserveEnv: ["TEAM_ONLY"] }, teamOnly: { pool: [9000] } },
          "rt.intercepts": [{ command: "team-cmd", matches: [{ cwdGlob: ".", role: "teamOnly" }] }],
        },
      },
    });
    write(userSettingsPath(), {
      repos: { [IDENTITY]: { "rt.roles": { backend: { pool: [{ from: 2000, to: 2000 }] } } } },
    });
    write(machineSettingsPath(), {
      repos: {
        [IDENTITY]: {
          "rt.intercepts": [{ command: "machine-cmd", matches: [{ cwdGlob: ".", role: "backend" }] }],
        },
      },
    });

    const cfg = loadEndpointConfig({ repoIdentity: IDENTITY, repoName: "r-merge" });
    expect(cfg.roles.backend!.pool).toEqual([2000]); // user wins the pool leaf
    expect(cfg.roles.backend!.preserveEnv).toEqual(["TEAM_ONLY"]); // team-only leaf survives
    expect(cfg.roles.teamOnly!.pool).toEqual([9000]); // team-only role survives
    expect(cfg.intercepts.map((i) => i.command)).toEqual(["machine-cmd"]); // replace, not splice
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

  test("a null identity makes repo store sections unreachable, even when one is authored", () => {
    write(teamSettingsPath(TEAM), {
      repos: { [IDENTITY]: { "rt.roles": { web: { pool: [{ from: 4000, to: 4000 }] } } } },
    });
    expect(loadEndpointConfig({ repoIdentity: null, repoName: "r-null" }).roles).toEqual({});
  });
});
