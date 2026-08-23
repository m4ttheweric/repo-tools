import { describe, test, expect, beforeEach } from "bun:test";
import { loadEnrichment, stripJsonc } from "../enrichment.ts";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { teamSettingsPath } from "../../rt-paths.ts";

function writeStore(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

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
  // rt.sdmEnrichment reads through the settings resolver now (ownership
  // latch), so every case here needs an isolated HOME — a real ~/.mattstack
  // must never leak into these reads.
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "enr-home-")));
  });

  const write = (s: string) => { const p = join(mkdtempSync(join(tmpdir(), "enr-")), "e.jsonc"); writeFileSync(p, s); return p; };

  test("store unowned: reads a JSONC map from the file", () => {
    const p = write(`{ "assured-pgr-qa": { "label": "progressive qa", "db": { "schema": "assured" } } }`);
    expect(loadEnrichment(p)).toEqual({ "assured-pgr-qa": { label: "progressive qa", db: { schema: "assured" } } });
  });
  test("store unowned, missing file -> {}", () => { expect(loadEnrichment(join(tmpdir(), "nope-x.jsonc"))).toEqual({}); });
  test("store unowned, corrupt file -> {} (never throws)", () => { expect(loadEnrichment(write("{ not json"))).toEqual({}); });

  test("store-owned: store wins wholesale, the file is never consulted", () => {
    const p = write(`{ "file-only": { "label": "from file" } }`);
    writeStore(teamSettingsPath("acme"), {
      "rt.sdmEnrichment": { "assured-pgr-qa": { label: "from store", tier: "gold" } },
    });

    expect(loadEnrichment(p)).toEqual({ "assured-pgr-qa": { label: "from store", tier: "gold" } });
  });

  test("store shape validation: a non-object store value is refused, falling back to the file", () => {
    const p = write(`{ "assured-pgr-qa": { "label": "from file" } }`);
    writeStore(teamSettingsPath("acme"), { "rt.sdmEnrichment": ["nope"] });

    expect(loadEnrichment(p)).toEqual({ "assured-pgr-qa": { label: "from file" } });
  });
});
