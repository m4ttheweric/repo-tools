import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectEditors, EDITOR_PATTERNS } from "../editors.ts";

describe("EDITOR_PATTERNS", () => {
  test("covers the known VS Code-family editors", () => {
    expect(EDITOR_PATTERNS.length).toBeGreaterThanOrEqual(6);
    const names = EDITOR_PATTERNS.map((p) => p.displayName);
    expect(names).toContain("Cursor");
    expect(names).toContain("Visual Studio Code");
  });

  test("every pattern has a non-empty appName, cliBinary, and displayName", () => {
    for (const pattern of EDITOR_PATTERNS) {
      expect(pattern.appName.length).toBeGreaterThan(0);
      expect(pattern.cliBinary.length).toBeGreaterThan(0);
      expect(pattern.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe("detectEditors(appDirs)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rt-editors-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedApp(appName: string, cliBinary: string, dir: string = root): void {
    const cliDir = join(dir, appName, "Contents/Resources/app/bin");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, cliBinary), "#!/bin/sh\n");
  }

  test("no app dirs exist -> []", () => {
    expect(detectEditors([join(root, "does-not-exist")])).toEqual([]);
  });

  test("an app dir exists but has no matching .app bundles -> []", () => {
    mkdirSync(join(root, "empty"));
    expect(detectEditors([join(root, "empty")])).toEqual([]);
  });

  test("a fully seeded Cursor.app is detected with the right paths", () => {
    seedApp("Cursor.app", "cursor");
    const found = detectEditors([root]);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      name: "Cursor",
      cliPath: join(root, "Cursor.app", "Contents/Resources/app/bin", "cursor"),
      appPath: join(root, "Cursor.app"),
    });
  });

  test("the .app bundle exists but its CLI binary is missing -> not detected", () => {
    mkdirSync(join(root, "Cursor.app", "Contents/Resources/app/bin"), { recursive: true });
    expect(detectEditors([root])).toEqual([]);
  });

  test("multiple editors across multiple app dirs are all found", () => {
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    seedApp("Cursor.app", "cursor", dirA);
    seedApp("Visual Studio Code.app", "code", dirB);
    const names = detectEditors([dirA, dirB])
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(["Cursor", "Visual Studio Code"]);
  });

  test("called with no args scans the real machine and never throws", () => {
    expect(() => detectEditors()).not.toThrow();
  });
});
