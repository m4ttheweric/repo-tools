/**
 * lib/state/db.ts — schema convergence on every open (R015, R056).
 *
 * The schema DDL now applies on every `openStateDb`, not only while
 * `user_version < SCHEMA_VERSION`, so a db already stamped at SCHEMA_VERSION
 * but missing a column or table (dropped by hand, by a bug, or by a partial
 * write) self-heals on its next open instead of staying broken forever.
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, openStateDb, SCHEMA_VERSION } from "../db.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-state-db-convergence-"));
});

afterEach(() => {
  closeStateDb();
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(db: Database): string[] {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table';").all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columnNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table});`).all() as { name: string }[]).map((c) => c.name);
}

describe("self-heal: a db at SCHEMA_VERSION missing schema converges on reopen", () => {
  test("a column dropped from an at-version db is back after the next open", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect((db.query("PRAGMA user_version;").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(columnNames(db, "chat_rooms")).toContain("archived_at");
    // SQLite >= 3.35 supports DROP COLUMN — fixture stays at SCHEMA_VERSION,
    // the exact shape a self-heal (not a version migration) must repair.
    db.exec("ALTER TABLE chat_rooms DROP COLUMN archived_at;");
    expect(columnNames(db, "chat_rooms")).not.toContain("archived_at");
    db.close();

    const healed = openStateDb(dbPath, "cli");
    expect((healed.query("PRAGMA user_version;").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(columnNames(healed, "chat_rooms")).toContain("archived_at");
    healed.close();
  });

  test("a table dropped from an at-version db is back after the next open", () => {
    const dbPath = join(dir, "state.db");
    const db = openStateDb(dbPath, "cli");
    expect((db.query("PRAGMA user_version;").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(tableNames(db)).toContain("project_mr_sections");
    db.exec("DROP TABLE project_mr_sections;");
    expect(tableNames(db)).not.toContain("project_mr_sections");
    db.close();

    const healed = openStateDb(dbPath, "cli");
    expect((healed.query("PRAGMA user_version;").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(tableNames(healed)).toContain("project_mr_sections");
    healed.close();
  });
});

describe("dynamic table-presence: every CREATE TABLE in db.ts source exists after a fresh open", () => {
  test("every CREATE TABLE IF NOT EXISTS name in db.ts is present in sqlite_master", () => {
    const src = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
    const names = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);

    const db = openStateDb(join(dir, "state.db"), "cli");
    const present = new Set(tableNames(db));
    for (const name of names) {
      expect(present.has(name)).toBe(true);
    }
    db.close();
  });
});

describe("idempotency: repeated opens never throw", () => {
  test("opening the same db three times in a row does not throw", () => {
    const dbPath = join(dir, "state.db");
    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
    expect(() => openStateDb(dbPath, "cli").close()).not.toThrow();
    expect(existsSync(dbPath)).toBe(true);
  });
});
