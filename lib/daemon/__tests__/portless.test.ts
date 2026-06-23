import { describe, test, expect } from "bun:test";
import { buildPortlessCommand, portlessAvailable } from "../portless.ts";

describe("buildPortlessCommand", () => {
  test("wraps an inner command in `portless run`", () => {
    expect(buildPortlessCommand("pnpm run dev")).toBe("portless run pnpm run dev");
  });
  test("leaves the inner command otherwise untouched", () => {
    expect(buildPortlessCommand("vite --mode dev")).toBe("portless run vite --mode dev");
  });
});

describe("portlessAvailable", () => {
  test("true when the resolver finds the binary", () => {
    expect(portlessAvailable(() => "/usr/local/bin/portless")).toBe(true);
  });
  test("false when the resolver finds nothing", () => {
    expect(portlessAvailable(() => null)).toBe(false);
  });
});
