import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import { loadPresets, savePreset, findPreset, type Preset } from "../run-presets.ts";

const IDENTITY = "gitlab.com/acme/test-repo";

describe("run-presets over the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-presets-test-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty array when nothing is declared", () => {
    expect(loadPresets(IDENTITY)).toEqual([]);
  });

  it("returns empty array when no repo identity is available", () => {
    expect(loadPresets(null)).toEqual([]);
  });

  it("saves and loads a preset", () => {
    const preset: Preset = {
      name: "full-stack",
      entries: [
        { packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" },
        { packageRelPath: "apps/portal", packageLabel: "portal", script: "start:lite" },
      ],
    };
    savePreset(IDENTITY, preset);
    const loaded = loadPresets(IDENTITY);
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
    savePreset(IDENTITY, preset);
    expect(findPreset(IDENTITY, "lite")).not.toBeNull();
    expect(findPreset(IDENTITY, "lite")!.name).toBe("lite");
    expect(findPreset(IDENTITY, "nonexistent")).toBeNull();
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
    savePreset(IDENTITY, preset);
    const found = findPreset(IDENTITY, "with-vars")!;
    expect(found.entries[0]!.variationName).toBe("dashboard");
    expect(found.entries[0]!.command).toBe("DASHBOARD=1 doppler run -- parcel serve");
  });

  it("overwrites an existing preset with the same name, leaving others intact", () => {
    savePreset(IDENTITY, {
      name: "lite",
      entries: [{ packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" }],
    });
    savePreset(IDENTITY, {
      name: "full",
      entries: [{ packageRelPath: "apps/frontend", packageLabel: "frontend", script: "start" }],
    });
    savePreset(IDENTITY, {
      name: "lite",
      entries: [{ packageRelPath: "apps/portal", packageLabel: "portal", script: "start:lite" }],
    });

    const loaded = loadPresets(IDENTITY);
    expect(loaded).toHaveLength(2);
    const lite = findPreset(IDENTITY, "lite")!;
    expect(lite.entries).toHaveLength(1);
    expect(lite.entries[0]!.packageRelPath).toBe("apps/portal");
    expect(findPreset(IDENTITY, "full")).not.toBeNull();
  });

  it("savePreset reports no-identity and is a no-op when no repo identity is available", () => {
    const result = savePreset(null, {
      name: "lite",
      entries: [{ packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" }],
    });
    expect(result).toEqual({ ok: false, reason: "no-identity" });
    expect(loadPresets(null)).toEqual([]);
  });

  it("savePreset reports ok:true on a successful write", () => {
    const result = savePreset(IDENTITY, {
      name: "lite",
      entries: [{ packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" }],
    });
    expect(result).toEqual({ ok: true });
  });

  it("stores the shape as { <name>: { entries: [...] } } under the key", () => {
    savePreset(IDENTITY, {
      name: "lite",
      entries: [{ packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" }],
    });
    const stored = getSetting<Record<string, { entries: unknown[] }>>("rt.presets", { repoIdentity: IDENTITY }).value;
    expect(stored).toEqual({
      lite: { entries: [{ packageRelPath: "apps/backend", packageLabel: "backend", script: "start:lite" }] },
    });
  });

  it("an unexpandable ${repoRoot} in a stored value degrades to empty instead of throwing", () => {
    setSetting("rt.presets", { lite: { entries: "${repoRoot}" } }, "user", { repoIdentity: IDENTITY });

    expect(() => loadPresets(IDENTITY)).not.toThrow();
  });
});
