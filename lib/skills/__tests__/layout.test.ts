import { expect, test } from "bun:test";
import { outDirFor, otherSideDir } from "../layout.ts";

test("outDirFor places public under skills/ and internal under attachments/", () => {
  expect(outDirFor("/pack", "work", true)).toBe("/pack/skills/work");
  expect(outDirFor("/pack", "stage-plan", false)).toBe("/pack/attachments/stage-plan");
});

test("otherSideDir names the stale location for a name that flipped sides", () => {
  expect(otherSideDir("/pack", "work", true)).toBe("/pack/attachments/work");
  expect(otherSideDir("/pack", "checkout", false)).toBe("/pack/skills/checkout");
});
