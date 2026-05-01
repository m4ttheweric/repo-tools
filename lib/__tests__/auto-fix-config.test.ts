import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-auto-fix-config-"));
process.env.HOME = tmpHome;

const { loadAutoFixConfig, saveAutoFixConfig, autoFixConfigPath, DEFAULTS } =
  await import("../auto-fix-config.ts");

describe("auto-fix-config", () => {
  const repo = "test-repo";

  afterEach(() => {
    try { rmSync(join(tmpHome, ".rt", repo), { recursive: true, force: true }); } catch { /* */ }
  });

  test("autoFixConfigPath is ~/.rt/<repo>/auto-fix.json", () => {
    expect(autoFixConfigPath(repo)).toBe(join(tmpHome, ".rt", repo, "auto-fix.json"));
  });

  test("loadAutoFixConfig returns DEFAULTS when file is missing", () => {
    expect(loadAutoFixConfig(repo)).toEqual(DEFAULTS);
  });

  test("loadAutoFixConfig returns DEFAULTS on malformed JSON", () => {
    mkdirSync(join(tmpHome, ".rt", repo), { recursive: true });
    writeFileSync(autoFixConfigPath(repo), "{not json");
    expect(loadAutoFixConfig(repo)).toEqual(DEFAULTS);
  });

  test("saveAutoFixConfig then loadAutoFixConfig round-trips", () => {
    saveAutoFixConfig(repo, {
      enabled: false,
      fileCap: 10,
      lineCap: 500,
      additionalDenylist: ["src/legacy/**"],
      allowTestFixes: true,
      setupCommands: [["bun", "install"], ["bun", "run", "gen"]],
    });
    expect(loadAutoFixConfig(repo)).toEqual({
      enabled: false,
      fileCap: 10,
      lineCap: 500,
      additionalDenylist: ["src/legacy/**"],
      allowTestFixes: true,
      setupCommands: [["bun", "install"], ["bun", "run", "gen"]],
    });
  });

  test("loadAutoFixConfig fills missing fields with DEFAULTS", () => {
    mkdirSync(join(tmpHome, ".rt", repo), { recursive: true });
    writeFileSync(autoFixConfigPath(repo), JSON.stringify({ enabled: false }));
    const cfg = loadAutoFixConfig(repo);
    expect(cfg.enabled).toBe(false);
    expect(cfg.fileCap).toBe(DEFAULTS.fileCap);
    expect(cfg.lineCap).toBe(DEFAULTS.lineCap);
  });
});
