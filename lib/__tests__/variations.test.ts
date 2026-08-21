import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import { teamSettingsPath } from "../rt-paths.ts";
import {
  loadVariations,
  saveVariation,
  variationKey,
  type Variation,
} from "../variations.ts";

const IDENTITY = "gitlab.com/acme/test-repo";

/** saveVariation writes to team scope, which refuses without a local team store. */
function seedTeam(): void {
  const path = teamSettingsPath("acme");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// team store\n{}\n");
}

describe("variations", () => {
  describe("variationKey", () => {
    test("joins repo-relative package path and script with colon", () => {
      // packagePath is absolute; variationKey computes relative(repoRoot, packagePath)
      expect(variationKey("/repo", "/repo/pkg/a", "dev")).toBe(
        "pkg/a:dev",
      );
    });

    test("uses '.' for the root package (packagePath === repoRoot)", () => {
      expect(variationKey("/repo", "/repo", "build")).toBe(
        ".:build",
      );
    });
  });

  describe("over the settings resolver", () => {
    const origHome = process.env.HOME;
    let home: string;

    beforeEach(() => {
      home = realpathSync(mkdtempSync(join(tmpdir(), "rt-variations-test-")));
      process.env.HOME = home;
      seedTeam();
    });

    afterEach(() => {
      process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    });

    describe("loadVariations", () => {
      test("returns empty object when nothing is declared", () => {
        expect(loadVariations(IDENTITY)).toEqual({});
      });

      test("returns empty object when no repo identity is available", () => {
        expect(loadVariations(null)).toEqual({});
      });

      test("an unexpandable ${repoRoot} in a stored value degrades to empty instead of throwing", () => {
        setSetting("rt.variations", { "pkg/a:dev": "${repoRoot}" }, "team", { repoIdentity: IDENTITY });

        expect(() => loadVariations(IDENTITY)).not.toThrow();
        expect(loadVariations(IDENTITY)).toEqual({});
      });
    });

    describe("saveVariation + loadVariations roundtrip", () => {
      test("saves and loads a single variation", () => {
        saveVariation(IDENTITY, "/repo", "/repo/pkg/a", "dev", {
          name: "debug",
          command: "DEBUG=1 pnpm run dev",
        });

        const all = loadVariations(IDENTITY);
        expect(all["pkg/a:dev"]).toEqual([
          { name: "debug", command: "DEBUG=1 pnpm run dev" },
        ]);
      });

      test("appends to existing variations for the same key", () => {
        saveVariation(IDENTITY, "/repo", "/repo/pkg/a", "dev", {
          name: "debug",
          command: "DEBUG=1 pnpm run dev",
        });
        saveVariation(IDENTITY, "/repo", "/repo/pkg/a", "dev", {
          name: "inspect",
          command: "pnpm run dev -- --inspect",
        });

        const all = loadVariations(IDENTITY);
        expect(all["pkg/a:dev"]).toHaveLength(2);
        expect(all["pkg/a:dev"]![1]!.name).toBe("inspect");
      });

      test("stores variations for different keys independently", () => {
        saveVariation(IDENTITY, "/repo", "/repo/pkg/a", "dev", {
          name: "debug",
          command: "DEBUG=1 pnpm run dev",
        });
        saveVariation(IDENTITY, "/repo", "/repo/pkg/b", "start", {
          name: "verbose",
          command: "VERBOSE=1 pnpm start",
        });

        const all = loadVariations(IDENTITY);
        expect(Object.keys(all)).toHaveLength(2);
      });

      test("saveVariation is a no-op when no repo identity is available", () => {
        saveVariation(null, "/repo", "/repo/pkg/a", "dev", {
          name: "debug",
          command: "DEBUG=1 pnpm run dev",
        });
        expect(loadVariations(null)).toEqual({});
      });

      test("lands in the team store (scope decision: team.repo)", () => {
        saveVariation(IDENTITY, "/repo", "/repo/pkg/a", "dev", {
          name: "debug",
          command: "DEBUG=1 pnpm run dev",
        });

        const explicit: Variation[] = getSetting<Record<string, Variation[]>>(
          "rt.variations",
          { repoIdentity: IDENTITY },
        ).value["pkg/a:dev"]!;
        expect(explicit).toEqual([{ name: "debug", command: "DEBUG=1 pnpm run dev" }]);
      });
    });
  });
});
