import { describe, expect, test } from "bun:test";
import { selfPaneRef } from "../self-pane.ts";

describe("selfPaneRef", () => {
  test("undefined with no HERDR_PANE_ID", () => {
    expect(selfPaneRef({})).toBeUndefined();
  });
  test("bare ref on the visible server (no HERDR_SESSION)", () => {
    expect(selfPaneRef({ HERDR_PANE_ID: "w1:p1" })).toBe("w1:p1");
  });
  test("bare ref when HERDR_SESSION is set to anything but bg", () => {
    expect(selfPaneRef({ HERDR_PANE_ID: "w1:p1", HERDR_SESSION: "herd" })).toBe("w1:p1");
  });
  test("bg: ref when HERDR_SESSION is bg", () => {
    expect(selfPaneRef({ HERDR_PANE_ID: "w1:p1", HERDR_SESSION: "bg" })).toBe("bg:w1:p1");
  });
});
