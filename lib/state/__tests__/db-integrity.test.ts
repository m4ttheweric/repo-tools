/**
 * lib/state/db.ts -- backupTo (VACUUM INTO) and quickCheck coverage (R055).
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb, backupTo, quickCheck } from "../db.ts";

let n = 0;
function tempPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `db-integrity-${label}-`)), "state.db");
}

test("backupTo writes a db that reopens with the same tables and rows", () => {
  const src = openStateDb(tempPath(`src-${n++}`));
  src.query("INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)").run("test-ns", "test-key", "\"hello\"", Date.now());

  const dest = join(mkdtempSync(join(tmpdir(), "db-integrity-dest-")), "backup.db");
  backupTo(src, dest);

  const restored = new Database(dest, { readonly: true });
  const row = restored.query("SELECT v FROM kv WHERE ns = ? AND k = ?").get("test-ns", "test-key") as { v: string } | null;
  expect(row?.v).toBe("\"hello\"");
  const tables = restored.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  expect(tables.some((t) => t.name === "chat_messages")).toBe(true);
  restored.close();
});

test("quickCheck returns an empty list on a healthy db", () => {
  const db = openStateDb(tempPath(`healthy-${n++}`));
  expect(quickCheck(db)).toEqual([]);
});

test("quickCheck returns a nonempty list on a deliberately corrupted db", () => {
  const path = tempPath(`corrupt-${n++}`);
  const db = openStateDb(path);
  db.exec("PRAGMA journal_mode = DELETE;");
  for (let i = 0; i < 300; i++) {
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES (?, ?, ?, ?)").run("ns", `key-${i}`, "x".repeat(80), Date.now());
  }
  db.close();

  const size = statSync(path).size;
  const buf = readFileSync(path);
  for (let i = 100; i < size; i += 7) buf[i] = ((buf[i] ?? 0) + 123) % 256;
  writeFileSync(path, buf);

  const reopened = new Database(path);
  const problems = quickCheck(reopened);
  expect(problems.length).toBeGreaterThan(0);
});
