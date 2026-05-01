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

const { getScopedEntry, addScopedEntry } = await import("../doppler-config.ts");

describe("getScopedEntry", () => {
  test("returns undefined when path is not present", () => {
    const cfg: any = { scoped: {} };
    expect(getScopedEntry(cfg, "/Users/matt/repo/apps/backend")).toBeUndefined();
  });

  test("returns the entry when present", () => {
    const cfg: any = {
      scoped: {
        "/Users/matt/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
      },
    };
    expect(getScopedEntry(cfg, "/Users/matt/repo/apps/backend")).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });
});

describe("addScopedEntry", () => {
  test("adds an entry when missing and returns 'wrote'", () => {
    const cfg: any = { scoped: {} };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    expect(result).toBe("wrote");
    expect(cfg.scoped["/repo/apps/backend"]).toEqual({
      "enclave.project": "backend",
      "enclave.config":  "dev",
    });
  });

  test("leaves existing matching entry alone and returns 'unchanged'", () => {
    const cfg: any = {
      scoped: {
        "/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "dev",
        },
      },
    };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    expect(result).toBe("unchanged");
  });

  test("leaves a different existing entry alone and returns 'overridden'", () => {
    const cfg: any = {
      scoped: {
        "/repo/apps/backend": {
          "enclave.project": "backend",
          "enclave.config":  "staging",
        },
      },
    };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    expect(result).toBe("overridden");
    expect(cfg.scoped["/repo/apps/backend"]["enclave.config"]).toBe("staging");
  });

  test("an entry with only a token (no enclave.*) returns 'overridden'", () => {
    const cfg: any = {
      scoped: {
        "/repo/apps/backend": { token: "secret-xyz" },
      },
    };
    const result = addScopedEntry(cfg, "/repo/apps/backend", "backend", "dev");
    // Conservative: any existing entry is treated as a deliberate override.
    expect(result).toBe("overridden");
  });
});
