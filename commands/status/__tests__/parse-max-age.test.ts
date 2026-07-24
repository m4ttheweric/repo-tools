import { describe, test, expect } from "bun:test";
import { parseMaxAge } from "../data.ts";

describe("parseMaxAge", () => {
  test("bare number is seconds", () => expect(parseMaxAge("45")).toBe(45_000));
  test("s suffix", () => expect(parseMaxAge("30s")).toBe(30_000));
  test("m suffix", () => expect(parseMaxAge("2m")).toBe(120_000));
  test("h suffix", () => expect(parseMaxAge("1h")).toBe(3_600_000));
  test("whitespace tolerated", () => expect(parseMaxAge(" 10s ")).toBe(10_000));
  test("zero is valid (always refresh)", () => expect(parseMaxAge("0")).toBe(0));
  test("garbage returns null", () => {
    expect(parseMaxAge("abc")).toBeNull();
    expect(parseMaxAge("5d")).toBeNull();
    expect(parseMaxAge("-5s")).toBeNull();
    expect(parseMaxAge("")).toBeNull();
  });
});
