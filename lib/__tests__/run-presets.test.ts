import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadPresets, savePreset, findPreset, type Preset } from "../run-presets.ts";

describe("run-presets", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rt-presets-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns empty array when no presets directory exists", () => {
    expect(loadPresets(dataDir)).toEqual([]);
  });

  it("saves and loads a preset", () => {
    const preset: Preset = {
      name: "full-stack",
      entries: [
        { packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" },
        { packageRelPath: "apps/portal", packageLabel: "portal", script: "start:lite" },
      ],
    };
    savePreset(dataDir, preset);
    const loaded = loadPresets(dataDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe("full-stack");
    expect(loaded[0]!.entries).toHaveLength(2);
  });

  it("finds a preset by name", () => {
    const preset: Preset = {
      name: "lite",
      entries: [
        { packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" },
      ],
    };
    savePreset(dataDir, preset);
    expect(findPreset(dataDir, "lite")).not.toBeNull();
    expect(findPreset(dataDir, "lite")!.name).toBe("lite");
    expect(findPreset(dataDir, "nonexistent")).toBeNull();
  });

  it("saves preset with variation info", () => {
    const preset: Preset = {
      name: "with-vars",
      entries: [
        {
          packageRelPath: "apps/portal",
          packageLabel: "portal",
          script: "start:lite",
          variationName: "dashboard",
          command: "DASHBOARD=1 doppler run -- parcel serve",
        },
      ],
    };
    savePreset(dataDir, preset);
    const found = findPreset(dataDir, "with-vars")!;
    expect(found.entries[0]!.variationName).toBe("dashboard");
    expect(found.entries[0]!.command).toBe("DASHBOARD=1 doppler run -- parcel serve");
  });

  it("handles corrupted JSON gracefully", () => {
    mkdirSync(join(dataDir, "presets"), { recursive: true });
    writeFileSync(join(dataDir, "presets", "bad.json"), "not json{{{");
    expect(loadPresets(dataDir)).toEqual([]);
  });

  it("overwrites an existing preset with the same name", () => {
    savePreset(dataDir, {
      name: "lite",
      entries: [{ packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" }],
    });
    savePreset(dataDir, {
      name: "lite",
      entries: [{ packageRelPath: "apps/portal", packageLabel: "portal", script: "start:lite" }],
    });

    const loaded = loadPresets(dataDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.entries).toHaveLength(1);
    expect(loaded[0]!.entries[0]!.packageRelPath).toBe("apps/portal");
  });

  it("ignores non-json files in the presets directory", () => {
    mkdirSync(join(dataDir, "presets"), { recursive: true });
    writeFileSync(join(dataDir, "presets", "notes.txt"), "hello");
    savePreset(dataDir, {
      name: "lite",
      entries: [{ packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" }],
    });

    expect(loadPresets(dataDir)).toHaveLength(1);
  });
});
