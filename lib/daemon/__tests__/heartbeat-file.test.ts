import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeHeartbeat, readHeartbeat } from "../heartbeat-file.ts";

test("write then read round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  writeHeartbeat(dir, { at: 123, seq: 7 });
  expect(readHeartbeat(dir)).toEqual({ at: 123, seq: 7 });
});

test("missing file reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  expect(readHeartbeat(dir)).toBeNull();
});

test("corrupt file reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  writeFileSync(join(dir, "daemon-heartbeat.json"), "{not json");
  expect(readHeartbeat(dir)).toBeNull();
});

test("a partial-but-valid-JSON object (missing `at`) reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  writeFileSync(join(dir, "daemon-heartbeat.json"), JSON.stringify({ seq: 1 }));
  expect(readHeartbeat(dir)).toBeNull();
});

test("a second write overwrites atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  writeHeartbeat(dir, { at: 1, seq: 1 });
  writeHeartbeat(dir, { at: 2, seq: 2 });
  expect(readHeartbeat(dir)).toEqual({ at: 2, seq: 2 });
});
