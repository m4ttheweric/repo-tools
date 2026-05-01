import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpHome = mkdtempSync(join(tmpdir(), "rt-doppler-config-"));
process.env.HOME = tmpHome;

const { loadDopplerConfig, dopplerConfigPath, writeDopplerConfig } =
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

  test("filters out non-object scoped entries (null, scalars)", () => {
    const yaml = [
      "scoped:",
      "    /good:",
      "        token: secret-good",
      "    /bad-null: null",
      "    /bad-scalar: 123",
      "    /bad-string: just-a-string",
      "",
    ].join("\n");
    mkdirSync(join(tmpHome, ".doppler"), { recursive: true });
    writeFileSync(dopplerConfigPath(), yaml);

    const cfg = loadDopplerConfig();
    expect(Object.keys(cfg.scoped).sort()).toEqual(["/good"]);
    expect(cfg.scoped["/good"]?.token).toBe("secret-good");
  });
});

describe("writeDopplerConfig", () => {
  afterEach(() => {
    try { rmSync(join(tmpHome, ".doppler"), { recursive: true, force: true }); } catch { /* */ }
  });

  test("creates the file when missing, including parent dir", () => {
    writeDopplerConfig({
      scoped: {
        "/Users/matt/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
      },
    });
    const cfg = loadDopplerConfig();
    expect(cfg.scoped["/Users/matt/repo/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });

  test("atomic-replaces an existing file (no .tmp left behind)", () => {
    mkdirSync(join(tmpHome, ".doppler"), { recursive: true });
    writeFileSync(dopplerConfigPath(), "scoped:\n  /:\n    token: old\n");

    writeDopplerConfig({
      scoped: {
        "/": { token: "new" },
      },
    });

    expect(loadDopplerConfig().scoped["/"]?.token).toBe("new");
    expect(existsSync(dopplerConfigPath() + ".tmp")).toBe(false);
  });

  test("preserves unknown top-level keys (e.g. fallback)", () => {
    const original: any = {
      scoped: { "/": { token: "abc" } },
      fallback: { foo: "bar" },
    };
    writeDopplerConfig(original);
    const reread = loadDopplerConfig();
    expect((reread as any).fallback).toEqual({ foo: "bar" });
  });
});
