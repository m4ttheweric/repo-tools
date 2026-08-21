import { describe, expect, test } from "bun:test";
import type { DepsLockTool } from "../../lib/bundle-layout.ts";
import { toTsvRow } from "../lib/deps-lock.ts";

function tool(overrides: Partial<DepsLockTool> = {}): DepsLockTool {
  return {
    name: "fzf",
    version: "1.0.0",
    license: "MIT",
    url: "https://example.com/x",
    sha256: "a".repeat(64),
    archive: "raw",
    extract: "",
    bundlePath: "Contents/Helpers/fzf",
    exec: ["Contents/Helpers/fzf"],
    exposeByDefault: false,
    entitlements: "none",
    status: "bundled",
    kind: "helper",
    ...overrides,
  };
}

describe("deps-lock.ts TSV emitter", () => {
  test("emits 11 tab-separated fields in the documented order", () => {
    expect(toTsvRow(tool()).split("\t")).toHaveLength(11);
  });
  test("throws rather than emit a field containing a tab", () => {
    expect(() => toTsvRow(tool({ version: "1.0\t0" }))).toThrow(/tab or newline/);
  });
  test("throws rather than emit a field containing a newline", () => {
    expect(() => toTsvRow(tool({ url: "https://example.com/x\ny" }))).toThrow(/tab or newline/);
  });
  test("throws rather than emit a field containing a carriage return", () => {
    expect(() => toTsvRow(tool({ extract: "a\rb" }))).toThrow(/tab or newline/);
  });
});
