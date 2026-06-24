import { describe, test, expect } from "bun:test";
import { appendedSuffix } from "../output-diff.ts";

describe("appendedSuffix", () => {
  test("returns the newly appended suffix", () => {
    expect(appendedSuffix("line1\n", "line1\nline2\n")).toBe("line2\n");
  });

  test("returns full string when prev is empty", () => {
    expect(appendedSuffix("", "abc")).toBe("abc");
  });

  test("returns empty string when nothing was appended", () => {
    expect(appendedSuffix("abc", "abc")).toBe("");
  });

  test("returns empty string when both are empty", () => {
    expect(appendedSuffix("", "")).toBe("");
  });

  test("handles multiline accumulation", () => {
    const prev = "line1\nline2\n";
    const cur = "line1\nline2\nline3\nline4\n";
    expect(appendedSuffix(prev, cur)).toBe("line3\nline4\n");
  });

  test("returns cur tail from divergence point when cur is shorter (truncation)", () => {
    // cur is completely different — return from divergence
    expect(appendedSuffix("abc", "axyz")).toBe("xyz");
  });

  test("when cur is shorter than prev (content shrank), returns empty common tail", () => {
    // prev="abc", cur="ab" — divergence at i=2 which equals cur.length, so cur.slice(2)==""
    expect(appendedSuffix("abc", "ab")).toBe("");
  });
});
