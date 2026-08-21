import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { teamSettingsPath } from "../rt-paths.ts";
import { setSetting } from "../settings/write.ts";
import { loadSyncConfig } from "../sync-config.ts";

const IDENTITY = "gitlab.com/acme/test-repo";

/** setSetting(..., "team", ...) refuses without a local team store (write.ts's team-selection rule). */
function seedTeam(): void {
  const path = teamSettingsPath("acme");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// team store\n{}\n");
}

describe("loadSyncConfig over the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-sync-config-")));
    process.env.HOME = home;
    seedTeam();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("returns defaults when nothing is declared", () => {
    expect(loadSyncConfig(IDENTITY)).toEqual({ autoResolve: [] });
  });

  test("returns defaults when no repo identity is available", () => {
    expect(loadSyncConfig(null)).toEqual({ autoResolve: [] });
  });

  test("a store-seeded value at team.repo scope resolves through the loader", () => {
    setSetting(
      "rt.sync",
      { autoResolve: [{ glob: "gen.txt", strategy: "theirs", postResolve: ["pnpm install"] }] },
      "team",
      { repoIdentity: IDENTITY },
    );

    expect(loadSyncConfig(IDENTITY)).toEqual({
      autoResolve: [{ glob: "gen.txt", strategy: "theirs", postResolve: ["pnpm install"] }],
    });
  });

  test("a wrong-shaped resolved value degrades to defaults", () => {
    setSetting("rt.sync", { autoResolve: "not-an-array" }, "team", { repoIdentity: IDENTITY });

    expect(loadSyncConfig(IDENTITY)).toEqual({ autoResolve: [] });
  });

  test("an unexpandable ${repoRoot} in a stored value degrades to defaults instead of throwing", () => {
    setSetting(
      "rt.sync",
      { autoResolve: [{ glob: "${repoRoot}/gen.txt", strategy: "theirs" }] },
      "team",
      { repoIdentity: IDENTITY },
    );

    expect(() => loadSyncConfig(IDENTITY)).not.toThrow();
    expect(loadSyncConfig(IDENTITY)).toEqual({ autoResolve: [] });
  });
});
