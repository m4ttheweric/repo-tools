/**
 * json-store — read-or-default / write-with-mkdir helpers shared by the per-repo
 * store modules.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readJson, writeJson } from "../json-store.ts";

describe("json-store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "json-store-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("readJson returns the fallback when the file is missing", () => {
    expect(readJson(join(dir, "nope.json"), { a: 1 })).toEqual({ a: 1 });
  });

  test("readJson returns the fallback on malformed JSON", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not valid json");
    expect(readJson(p, [])).toEqual([]);
  });

  test("readJson parses valid JSON", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify({ x: 5 }));
    expect(readJson<{ x: number }>(p, { x: 0 })).toEqual({ x: 5 });
  });

  test("writeJson creates missing parent directories and round-trips", () => {
    const p = join(dir, "a", "b", "c", "data.json");
    writeJson(p, { hello: "world" });
    expect(existsSync(p)).toBe(true);
    expect(readJson<{ hello: string } | null>(p, null)).toEqual({ hello: "world" });
  });

  test("writeJson pretty-prints with 2-space indent", () => {
    const p = join(dir, "pretty.json");
    writeJson(p, { a: 1 });
    expect(readFileSync(p, "utf8")).toBe('{\n  "a": 1\n}');
  });
});

describe("writeJson atomicity", () => {
  test("round-trips and leaves no tmp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonstore-"));
    const p = join(dir, "nested", "file.json");
    writeJson(p, { a: 1 });
    expect(readJson<{ a: number } | null>(p, null)).toEqual({ a: 1 });
    const { readdirSync } = require("fs");
    expect(readdirSync(join(dir, "nested"))).toEqual(["file.json"]);
  });
});
