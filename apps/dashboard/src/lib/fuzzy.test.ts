import { describe, test, expect } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.ts";

describe("fuzzyScore", () => {
  test("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "test")).toBeNull();
  });
  test("matches a subsequence", () => {
    expect(fuzzyScore("tic", "test:integration:ci")).not.toBeNull();
  });
  test("is case-insensitive", () => {
    expect(fuzzyScore("TEST", "test")).not.toBeNull();
  });
  test("empty query matches everything", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("fuzzyFilter", () => {
  const items = ["test", "test:ci", "test:integration:ci:hub", "request:changes", "build"];
  const key = (s: string) => s;

  test("excludes non-matches", () => {
    const out = fuzzyFilter("test", items, key);
    expect(out).not.toContain("build");
    expect(out).not.toContain("request:changes");
  });

  test("ranks the exact match first", () => {
    expect(fuzzyFilter("test", items, key)[0]).toBe("test");
  });

  test("ranks a prefix above a scattered subsequence", () => {
    const out = fuzzyFilter("ci", items, key);
    // "test:ci" has 'ci' at a word boundary; it should beat the deeper hub entry's later 'ci'
    expect(out.indexOf("test:ci")).toBeLessThan(out.indexOf("test:integration:ci:hub"));
  });

  test("word-boundary subsequence matches across segments", () => {
    expect(fuzzyFilter("tici", items, key)).toContain("test:integration:ci:hub");
  });

  test("empty query returns all items in original order", () => {
    expect(fuzzyFilter("", items, key)).toEqual(items);
  });
});
