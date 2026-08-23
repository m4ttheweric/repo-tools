/**
 * lib/state/legacy-import.ts — migrate-on-read mechanics, and specifically
 * `verifyPersisted`: `apply()` returning normally does NOT mean the write
 * landed, because every real caller writes through `persistOrWarn`
 * (lib/state/busy.ts), which warns and SWALLOWS `SQLITE_BUSY` rather than
 * throwing. These tests reproduce that with a
 * GENUINE held write lock (a second connection, `BEGIN IMMEDIATE`, zero
 * busy_timeout — same pattern as branch-cache.test.ts's `holdWriteLock`),
 * not a mock of `apply` or `setKvValue`.
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here. Stores are constructed via
 * openStateDb(tempPath) per the house convention.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { getKvValue, hasKvValue, setKvValue } from "../kv-blob.ts";
import { importLegacyJsonFile } from "../legacy-import.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-legacy-import-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A second connection that holds the write lock past a daemon-flavor connection's 250ms busy_timeout — a real SQLITE_BUSY, not a mock. */
function holdWriteLock(dbPath: string): { release: () => void } {
  const blocker = new Database(dbPath);
  blocker.exec("PRAGMA busy_timeout = 0;");
  blocker.exec("BEGIN IMMEDIATE;");
  return {
    release: () => { blocker.exec("ROLLBACK;"); blocker.close(); },
  };
}

describe("importLegacyJsonFile — verifyPersisted against a real contended write", () => {
  test("a swallowed SQLITE_BUSY leaves the legacy file in place, not renamed, even though apply() returned normally", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "daemon"); // 250ms busy_timeout
    const legacyPath = join(dir, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify({ n: 42 }));

    const lock = holdWriteLock(dbPath);
    let result: { imported: boolean; value?: number };
    try {
      result = importLegacyJsonFile<number>(legacyPath, (json) => {
        const n = (json as { n: number }).n;
        setKvValue("test-ns", "k", n, db); // persistOrWarn swallows the busy write here
        return n;
      }, { verifyPersisted: () => hasKvValue("test-ns", "k", db) });
    } finally {
      lock.release();
    }

    // apply() DID parse correctly, so this caller still gets the right value...
    expect(result!.imported).toBe(true);
    expect(result!.value).toBe(42);
    // ...but the write never landed, so the file must survive for a retry.
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(false);
    expect(hasKvValue("test-ns", "k", db)).toBe(false);

    db.close();
  }, 10_000);

  test("a retry once the lock is released succeeds and renames — the file was never destroyed by the failed attempt", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "daemon");
    const legacyPath = join(dir, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify({ n: 7 }));

    const lock = holdWriteLock(dbPath);
    importLegacyJsonFile<number>(legacyPath, (json) => {
      const n = (json as { n: number }).n;
      setKvValue("test-ns", "k2", n, db);
      return n;
    }, { verifyPersisted: () => hasKvValue("test-ns", "k2", db) });
    lock.release();

    expect(hasKvValue("test-ns", "k2", db)).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);

    const result = importLegacyJsonFile<number>(legacyPath, (json) => {
      const n = (json as { n: number }).n;
      setKvValue("test-ns", "k2", n, db);
      return n;
    }, { verifyPersisted: () => hasKvValue("test-ns", "k2", db) });

    expect(result.imported).toBe(true);
    expect(getKvValue("test-ns", "k2", -1, db)).toBe(7);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);

    db.close();
  }, 10_000);

  test("an uncontended write renames normally (verifyPersisted is not a permanent block)", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    const legacyPath = join(dir, "legacy.json");
    writeFileSync(legacyPath, JSON.stringify({ n: 9 }));

    const result = importLegacyJsonFile<number>(legacyPath, (json) => {
      const n = (json as { n: number }).n;
      setKvValue("test-ns", "k3", n, db);
      return n;
    }, { verifyPersisted: () => hasKvValue("test-ns", "k3", db) });

    expect(result.imported).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);

    db.close();
  });
});
