import { describe, it, expect } from "bun:test";
import { isInsideHerdr } from "../herdr-launch.ts";

describe("herdr-launch", () => {
  it("isInsideHerdr returns false when HERDR_ENV is unset", () => {
    const prev = process.env.HERDR_ENV;
    delete process.env.HERDR_ENV;
    expect(isInsideHerdr()).toBe(false);
    if (prev) process.env.HERDR_ENV = prev;
  });

  it("isInsideHerdr returns true when HERDR_ENV=1", () => {
    const prev = process.env.HERDR_ENV;
    process.env.HERDR_ENV = "1";
    expect(isInsideHerdr()).toBe(true);
    if (prev) process.env.HERDR_ENV = prev;
    else delete process.env.HERDR_ENV;
  });
});
