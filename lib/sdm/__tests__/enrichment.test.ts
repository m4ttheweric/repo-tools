import { describe, test, expect } from "bun:test";
import { loadEnrichment, stripJsonc } from "../enrichment.ts";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("stripJsonc", () => {
  test("removes line + block comments and trailing commas", () => {
    const out = stripJsonc(`{
      // a comment
      "a": 1, /* inline */
      "b": 2,   // trailing comma below
    }`);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });
});
describe("loadEnrichment", () => {
  const write = (s: string) => { const p = join(mkdtempSync(join(tmpdir(), "enr-")), "e.jsonc"); writeFileSync(p, s); return p; };
  test("reads a JSONC map", () => {
    const p = write(`{ "assured-pgr-qa": { "label": "progressive qa", "db": { "schema": "assured" } } }`);
    expect(loadEnrichment(p)).toEqual({ "assured-pgr-qa": { label: "progressive qa", db: { schema: "assured" } } });
  });
  test("missing file -> {}", () => { expect(loadEnrichment(join(tmpdir(), "nope-x.jsonc"))).toEqual({}); });
  test("corrupt file -> {} (never throws)", () => { expect(loadEnrichment(write("{ not json"))).toEqual({}); });
});
