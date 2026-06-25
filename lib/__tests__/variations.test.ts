import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadVariations,
  saveVariation,
  variationKey,
  type Variation,
} from "../variations.ts";

describe("variations", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rt-variations-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

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

  describe("loadVariations", () => {
    test("returns empty object when file does not exist", () => {
      expect(loadVariations(dataDir)).toEqual({});
    });

    test("returns empty object for malformed JSON", () => {
      const { writeFileSync, mkdirSync } = require("fs");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "variations.json"), "not json{");
      expect(loadVariations(dataDir)).toEqual({});
    });
  });

  describe("saveVariation + loadVariations roundtrip", () => {
    test("saves and loads a single variation", () => {
      saveVariation(dataDir, "/repo", "/repo/pkg/a", "dev", {
        name: "debug",
        command: "DEBUG=1 pnpm run dev",
      });

      const all = loadVariations(dataDir);
      expect(all["pkg/a:dev"]).toEqual([
        { name: "debug", command: "DEBUG=1 pnpm run dev" },
      ]);
    });

    test("appends to existing variations for the same key", () => {
      saveVariation(dataDir, "/repo", "/repo/pkg/a", "dev", {
        name: "debug",
        command: "DEBUG=1 pnpm run dev",
      });
      saveVariation(dataDir, "/repo", "/repo/pkg/a", "dev", {
        name: "inspect",
        command: "pnpm run dev -- --inspect",
      });

      const all = loadVariations(dataDir);
      expect(all["pkg/a:dev"]).toHaveLength(2);
      expect(all["pkg/a:dev"]![1]!.name).toBe("inspect");
    });

    test("stores variations for different keys independently", () => {
      saveVariation(dataDir, "/repo", "/repo/pkg/a", "dev", {
        name: "debug",
        command: "DEBUG=1 pnpm run dev",
      });
      saveVariation(dataDir, "/repo", "/repo/pkg/b", "start", {
        name: "verbose",
        command: "VERBOSE=1 pnpm start",
      });

      const all = loadVariations(dataDir);
      expect(Object.keys(all)).toHaveLength(2);
    });
  });
});
