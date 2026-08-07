import { describe, expect, test } from "bun:test";

import { stripJsonc } from "../jsonc.ts";

describe("stripJsonc", () => {
  test("removes line + block comments and trailing commas", () => {
    const out = stripJsonc(`{
      // a comment
      "a": 1, /* inline */
      "b": 2,   // trailing comma below
    }`);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2 });
  });

  test("preserves // inside string values (origin URLs)", () => {
    const out = stripJsonc(`{
      "origin": "https://gitlab.com/assured/assured-dev.git", // the mirror origin
    }`);
    expect(JSON.parse(out)).toEqual({ origin: "https://gitlab.com/assured/assured-dev.git" });
  });

  test("a comma inside a string before a closer is not a trailing comma", () => {
    const out = stripJsonc(`{ "a": "x,{}" }`);
    expect(JSON.parse(out)).toEqual({ a: "x,{}" });
  });

  test("handles escaped quotes inside strings", () => {
    const out = stripJsonc(`{ "a": "say \\"hi\\" // not a comment", }`);
    expect(JSON.parse(out)).toEqual({ a: 'say "hi" // not a comment' });
  });

  test("trailing commas in arrays", () => {
    expect(JSON.parse(stripJsonc(`[1, 2, /* three */ ]`))).toEqual([1, 2]);
  });
});
