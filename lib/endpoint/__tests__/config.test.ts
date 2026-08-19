import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoDataDir } from "../../rt-paths.ts";
import { loadEndpointRepoConfig } from "../config.ts";

function writeRepoConfig(repo: string, obj: unknown): void {
  const dir = repoDataDir(repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

describe("loadEndpointRepoConfig", () => {
  test("missing file yields empty config", () => {
    const cfg = loadEndpointRepoConfig("no-such-repo");
    expect(cfg.roles).toEqual({});
    expect(cfg.intercepts).toEqual([]);
  });

  test("flattens ranges, sorts and dedupes pools, applies defaults", () => {
    writeRepoConfig("r1", {
      roles: { backend: { pool: [{ from: 10402, to: 10404 }, 10400, 10400] } },
    });
    const cfg = loadEndpointRepoConfig("r1");
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
    const cfg = loadEndpointRepoConfig("r2");
    expect(Object.keys(cfg.roles)).toEqual(["ok"]);
    expect(cfg.roles.ok!.fixedPort).toBe(4002);
    expect(cfg.intercepts).toHaveLength(1);
    expect(cfg.intercepts[0]!.command).toBe("doppler");
  });

  test("coexists with other keys in the same document (worktrees, setup)", () => {
    writeRepoConfig("r3", { setup: [], worktrees: { onDeck: 2 }, roles: { web: { pool: [3000] } } });
    expect(loadEndpointRepoConfig("r3").roles.web!.pool).toEqual([3000]);
  });
});
