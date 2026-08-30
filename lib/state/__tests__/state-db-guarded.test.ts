import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { openStateDb } from "../index.ts";
import { openStateDbGuarded } from "../index.ts";
import { SCHEMA_VERSION } from "../db.ts";

let n = 0;
const tmp = () => join(tmpdir(), `guard-${process.pid}-${n++}.db`);
const uv = (db: Database) => (db.query("PRAGMA user_version;").get() as { user_version: number }).user_version;

test("creates and migrates a missing db", () => {
  const db = openStateDbGuarded(tmp());
  expect(uv(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test("opens an at-version db", () => {
  const p = tmp();
  openStateDb(p).close();
  const db = openStateDbGuarded(p);
  expect(uv(db)).toBe(SCHEMA_VERSION);
  db.close();
});

test("refuses a db newer than this build", () => {
  const p = tmp();
  openStateDb(p).close();
  const raw = new Database(p);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
  raw.close();
  expect(() => openStateDbGuarded(p)).toThrow(/newer than this rt build/);
});
