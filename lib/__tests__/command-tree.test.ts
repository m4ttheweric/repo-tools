import { describe, test, expect } from "bun:test";
import { walkTree, type CommandNode } from "../command-tree.ts";

const noop = async () => {};

const TREE: Record<string, CommandNode> = {
  branch: {
    description: "branch ops",
    subcommands: {
      switch: { description: "switch branch", handler: noop, aliases: ["sw"] },
      clean: { description: "clean branches", handler: noop },
    },
  },
  daemon: {
    description: "daemon ops",
    aliases: ["d"],
    subcommands: {
      logs: {
        description: "log viewer",
        subcommands: {
          tail: { description: "tail logs", handler: noop },
        },
      },
    },
  },
  cd: { description: "navigate", handler: noop },
};

describe("walkTree", () => {
  test("empty path returns the root tree", () => {
    expect(walkTree(TREE, [])).toBe(TREE);
  });

  test("walks one level to a branch node's subcommands", () => {
    expect(walkTree(TREE, ["branch"])).toBe(TREE.branch!.subcommands!);
  });

  test("walks nested levels", () => {
    expect(walkTree(TREE, ["daemon", "logs"])).toBe(
      TREE.daemon!.subcommands!.logs!.subcommands!,
    );
  });

  test("resolves aliases along the path", () => {
    expect(walkTree(TREE, ["d", "logs"])).toBe(
      TREE.daemon!.subcommands!.logs!.subcommands!,
    );
  });

  test("returns null for an unknown segment", () => {
    expect(walkTree(TREE, ["nope"])).toBeNull();
    expect(walkTree(TREE, ["branch", "nope"])).toBeNull();
  });

  test("returns null when the path ends on a leaf", () => {
    expect(walkTree(TREE, ["cd"])).toBeNull();
    expect(walkTree(TREE, ["branch", "switch"])).toBeNull();
  });
});
