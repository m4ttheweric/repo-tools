import { expect, test } from "bun:test";
import { hostDir, outDirFor, otherSideDir } from "../layout.ts";

test("outDirFor places public under skills/ and internal under attachments/", () => {
  expect(outDirFor("/pack", "work", true)).toBe("/pack/skills/work");
  expect(outDirFor("/pack", "stage-plan", false)).toBe("/pack/attachments/stage-plan");
});

test("otherSideDir names the stale location for a name that flipped sides", () => {
  expect(otherSideDir("/pack", "work", true)).toBe("/pack/attachments/work");
  expect(otherSideDir("/pack", "checkout", false)).toBe("/pack/skills/checkout");
});

test("hostDir names the token-relative dir a pack-side reader reaches a target at, on either side", () => {
  expect(hostDir("stage-plan", "attachments")).toBe("${CLAUDE_SKILL_DIR}/../../attachments/stage-plan");
  expect(hostDir("checkout", "skills")).toBe("${CLAUDE_SKILL_DIR}/../../skills/checkout");
});
