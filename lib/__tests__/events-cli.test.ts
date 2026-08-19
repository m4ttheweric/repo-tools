import { describe, test, expect } from "bun:test";
import { parseDuration, nextWaitMs } from "../../commands/events.ts";

describe("parseDuration", () => {
  test("suffixes", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });
  test("bare number = seconds", () => expect(parseDuration("45")).toBe(45_000));
  test("garbage is null", () => {
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("-5s")).toBeNull();
  });
});

describe("nextWaitMs", () => {
  test("no deadline → full daemon cap", () => expect(nextWaitMs(null, 1_000)).toBe(240_000));
  test("distant deadline → clamped to cap", () => expect(nextWaitMs(1_000_000, 0)).toBe(240_000));
  test("near deadline → remaining time", () => expect(nextWaitMs(5_000, 2_000)).toBe(3_000));
  test("passed deadline → 0", () => expect(nextWaitMs(1_000, 5_000)).toBe(0));
});
