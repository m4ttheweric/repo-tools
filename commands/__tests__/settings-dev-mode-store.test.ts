/**
 * commands/settings.ts — dev-mode config storage (state.db, ns='dev-mode',
 * k='config'). This row has an out-of-tree reader (see
 * rt-tray/Sources-daemon-shim/main.swift and lib/state/db.ts's note on the
 * kv table) — round-trip and migrate-on-read behavior here must stay
 * compatible with what that Swift reader expects.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { rtDir } from "../../lib/rt-paths.ts";
import { closeStateDb, getStateDb, hasKvValue, setKvValue } from "../../lib/state/index.ts";
import { devModeConfigPath, enableDevMode, readDevModeConfig } from "../settings.ts";

// commands/settings.ts's DEV_MODE_WRAPPER/DEV_MODE_PRELOAD are captured ONCE
// at module-load time (not call-time like rtDir()), so they stay pinned to
// whatever HOME was active when this test file's `import "../settings.ts"`
// first ran — enableDevMode() always writes both, so their parent dirs must
// exist there regardless of which HOME a given test points state.db at, and
// the files themselves must be cleaned up after every test: any other test
// file loaded in this same `bun test` process (no --isolate) resolves the
// same frozen paths and would otherwise see this suite's leftovers.
const WRAPPER_HOME = process.env.HOME!;
const DEVMODE_WRAPPER_PATH = join(WRAPPER_HOME, ".local", "bin", "rt");
const PRELOAD_PATH = join(WRAPPER_HOME, ".mattstack", "rt", "dev-restore-cwd.ts");

describe("dev-mode config (state.db)", () => {
  beforeEach(() => {
    process.env.HOME = mkdtempSync(join(tmpdir(), "rt-devmode-cfg-"));
    closeStateDb();
    mkdirSync(join(WRAPPER_HOME, ".local", "bin"), { recursive: true });
    mkdirSync(join(WRAPPER_HOME, ".mattstack", "rt"), { recursive: true });
  });

  // Other test files in this same `bun test` process (no --isolate) read
  // process.env.HOME at call time via rtDir()/home() and reuse the state.db
  // singleton — leaving HOME pointed at a throwaway per-test dir here would
  // misdirect their state.db reads/writes. Restore both after every test,
  // and remove any wrapper/preload files enableDevMode() wrote to the
  // frozen WRAPPER_HOME location.
  afterEach(() => {
    process.env.HOME = WRAPPER_HOME;
    closeStateDb();
    for (const p of [DEVMODE_WRAPPER_PATH, `${DEVMODE_WRAPPER_PATH}.new`, PRELOAD_PATH]) {
      try { rmSync(p); } catch { /* absent */ }
    }
  });

  test("empty reads as {}", () => {
    expect(readDevModeConfig()).toEqual({});
  });

  test("round-trip via enableDevMode", () => {
    enableDevMode("/tmp/source-repo");
    expect(readDevModeConfig()).toMatchObject({ sourcePath: "/tmp/source-repo" });
    expect(typeof readDevModeConfig().bunPath).toBe("string");
  });

  test("a malformed stored value ({}) reads as {}", () => {
    setKvValue("dev-mode", "config", {});
    expect(readDevModeConfig()).toEqual({});
  });

  test("a malformed stored value (null) reads as {}", () => {
    setKvValue("dev-mode", "config", null);
    expect(readDevModeConfig()).toEqual({});
  });

  test("a non-string sourcePath/bunPath is dropped, not thrown", () => {
    setKvValue("dev-mode", "config", { sourcePath: 42, bunPath: ["x"] });
    expect(readDevModeConfig()).toEqual({});
  });

  test("a pre-existing dev-mode.json is imported on first read", () => {
    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" }));
    expect(existsSync(path)).toBe(true);

    expect(readDevModeConfig()).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);

    // A second read sees the store, not a re-import.
    expect(readDevModeConfig()).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
  });

  test("a corrupt dev-mode.json warns and is left in place; readDevModeConfig reads as {}", () => {
    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not valid json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(readDevModeConfig()).toEqual({});
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("enableDevMode renames (never deletes) a legacy dev-mode.json it supersedes", () => {
    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" }));

    enableDevMode("/fresh/source");
    expect(readDevModeConfig()).toMatchObject({ sourcePath: "/fresh/source" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  });

  test("real contended write: a held write lock during readDevModeConfig's import must NOT rename dev-mode.json — the next read must still see it and retry", () => {
    // Materialize AND KEEP OPEN state.db's singleton first (never
    // closeStateDb() here): readDevModeConfig's own getStateDb() call must
    // reuse this already-migrated connection during the lock window below,
    // or its own open+migrate BEGIN IMMEDIATE would contend with the lock
    // too and throw past MIGRATION_BUSY_TIMEOUT_MS instead of the plain
    // write hitting persistOrWarn's swallow — a different failure than the
    // one this test targets.
    getStateDb();
    const dbPath = join(rtDir(), "state.db");

    const path = devModeConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" }));

    // A second, real connection holds the write lock past readDevModeConfig's
    // (cli-flavor, 5000ms) busy_timeout — a genuine SQLITE_BUSY, not a mock.
    const blocker = new Database(dbPath);
    blocker.exec("PRAGMA busy_timeout = 0;");
    blocker.exec("BEGIN IMMEDIATE;");

    let config: ReturnType<typeof readDevModeConfig>;
    try {
      config = readDevModeConfig();
    } finally {
      blocker.exec("ROLLBACK;");
      blocker.close();
    }

    // This caller still gets the correctly-parsed config (apply() did run)...
    expect(config).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
    // ...but the write never landed, so nothing may be destroyed: the file
    // must survive, and the store must still be empty.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.migrated`)).toBe(false);
    expect(hasKvValue("dev-mode", "config")).toBe(false);

    // The next read (lock released) succeeds for real and renames.
    expect(readDevModeConfig()).toEqual({ sourcePath: "/legacy/source", bunPath: "/legacy/bun" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.migrated`)).toBe(true);
  }, 20_000);
});
