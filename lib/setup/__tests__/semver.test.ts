import { describe, test, expect } from "bun:test";
import { atLeast } from "../semver.ts";

describe("atLeast", () => {
  test("above the floor", () => {
    expect(atLeast("0.8.0", "0.7.5")).toBe(true);
  });

  test("below the floor, leading 'v' ignored", () => {
    expect(atLeast("v0.7.4", "0.7.5")).toBe(false);
  });

  test("a shorter floor is satisfied by a matching prefix", () => {
    expect(atLeast("24.19.0", "24")).toBe(true);
  });

  test("exactly at the floor", () => {
    expect(atLeast("0.7.5", "0.7.5")).toBe(true);
  });

  test("trailing suffix ignored", () => {
    expect(atLeast("1.2.3-beta.1", "1.2.0")).toBe(true);
  });

  test("unparseable version fails closed (never above a real floor)", () => {
    expect(atLeast("not-a-version", "0.1.0")).toBe(false);
  });
});
