import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-config-"));
process.env.HOME = tmpHome;

const { loadDopplerConfig, dopplerConfigPath } =
  await import("../doppler-config.ts");

describe("loadDopplerConfig", () => {
  afterEach(() => {
    try { rmSync(join(tmpHome, ".doppler"), { recursive: true, force: true }); } catch { /* */ }
  });

  test("dopplerConfigPath is ~/.doppler/.doppler.yaml", () => {
    expect(dopplerConfigPath()).toBe(join(tmpHome, ".doppler", ".doppler.yaml"));
  });

  test("returns empty scoped object when file is missing", () => {
    expect(loadDopplerConfig()).toEqual({ scoped: {} });
  });

  test("returns empty scoped object on malformed YAML", () => {
    mkdirSync(join(tmpHome, ".doppler"), { recursive: true });
    writeFileSync(dopplerConfigPath(), "[invalid yaml:::");
    expect(loadDopplerConfig()).toEqual({ scoped: {} });
  });

  test("parses an existing file with scoped entries", () => {
    const yaml = [
      "scoped:",
      "    /:",
      "        token: secret-aaa",
      "    /Users/matt/repo/apps/backend:",
      "        enclave.project: backend",
      "        enclave.config: dev",
      "",
    ].join("\n");
    mkdirSync(join(tmpHome, ".doppler"), { recursive: true });
    writeFileSync(dopplerConfigPath(), yaml);

    const cfg = loadDopplerConfig();
    expect(cfg.scoped["/"]?.token).toBe("secret-aaa");
    expect(cfg.scoped["/Users/matt/repo/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });
});
