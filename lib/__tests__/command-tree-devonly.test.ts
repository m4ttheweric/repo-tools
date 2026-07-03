import { describe, test, expect } from "bun:test";
import { isNodeVisible, type CommandNode } from "../command-tree.ts";

const node = (extra: Partial<CommandNode> = {}): CommandNode => ({ description: "x", ...extra });

describe("isNodeVisible (devOnly gating)", () => {
  test("a plain node is visible in both prod and dev", () => {
    expect(isNodeVisible(node(), false)).toBe(true);
    expect(isNodeVisible(node(), true)).toBe(true);
  });

  test("a hidden node is never visible", () => {
    expect(isNodeVisible(node({ hidden: true }), false)).toBe(false);
    expect(isNodeVisible(node({ hidden: true }), true)).toBe(false);
  });

  test("a devOnly node is visible only in dev mode", () => {
    expect(isNodeVisible(node({ devOnly: true }), false)).toBe(false);
    expect(isNodeVisible(node({ devOnly: true }), true)).toBe(true);
  });

  test("hidden wins over devOnly even in dev mode", () => {
    expect(isNodeVisible(node({ hidden: true, devOnly: true }), true)).toBe(false);
  });
});
