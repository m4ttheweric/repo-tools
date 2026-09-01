import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRunDb, KNOWN_SCHEMA_VERSION, migrate, openRunDb } from "../write.ts";
import { seedRun } from "./fixtures.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rt-runs-write-"));
}

function cols(db: Database, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((r) => r.name);
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

describe("createRunDb", () => {
  test("creates the four tables, WAL mode, and stamps the current schema version", () => {
    const path = join(tmp(), "r", "20260901-000000-abcd-1", "state.db");
    const db = createRunDb(path);
    try {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(tables).toEqual(["decisions", "fields", "runs", "stages"]);
      expect(userVersion(db)).toBe(KNOWN_SCHEMA_VERSION);
      expect(cols(db, "stages")).toContain("reason");
      expect(cols(db, "runs")).toContain("pack_dirty");
      const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      expect(mode).toBe("wal");
    } finally {
      db.close();
    }
  });
});

describe("migrate", () => {
  test("brings a v1 DB to v2 in place and is idempotent", () => {
    const root = tmp();
    seedRun(root, "r", "20260901-000000-abcd-1", 1000, 1);
    const path = join(root, "r", "20260901-000000-abcd-1", "state.db");
    const db = openRunDb(path);
    try {
      expect(userVersion(db)).toBe(2);
      expect(cols(db, "stages")).toContain("detail_path");
      expect(cols(db, "runs")).toContain("pack_commits");
      migrate(db);
      expect(userVersion(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  test("openRunDb sets busy_timeout", () => {
    const path = join(tmp(), "r", "x", "state.db");
    createRunDb(path).close();
    const db = openRunDb(path);
    try {
      const t = (db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
      expect(t).toBe(5000);
    } finally {
      db.close();
    }
  });
});
