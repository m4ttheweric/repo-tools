import { describe, test, expect } from "bun:test";
import { uptime, basename } from "./format.ts";

describe("uptime", () => {
  test("seconds under a minute", () => {
    expect(uptime(10_000, 15_000)).toBe("5s");
  });
  test("minutes", () => {
    expect(uptime(0, 3 * 60_000)).toBe("3m");
  });
  test("hours and minutes", () => {
    expect(uptime(0, (60 + 2) * 60_000)).toBe("1h2m");
  });
  test("empty when no start time", () => {
    expect(uptime(undefined, 1000)).toBe("");
  });
  test("never negative", () => {
    expect(uptime(2000, 1000)).toBe("0s");
  });
});

describe("basename", () => {
  test("last path segment", () => {
    expect(basename("/Users/x/assured/assured-wktree-2")).toBe("assured-wktree-2");
  });
  test("trailing slash tolerated", () => {
    expect(basename("/a/b/")).toBe("b");
  });
});
