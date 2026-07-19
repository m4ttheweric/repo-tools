import { test, expect } from "bun:test";
import { walkTree } from "../lib/docs-walk.ts";
import type { CommandNode } from "../../lib/command-tree.ts";

test("walkTree yields leaf and branch pages with correct relPaths", () => {
  const tree: Record<string, CommandNode> = {
    git: {
      description: "Git",
      subcommands: {
        rebase: { description: "Rebase", module: "./commands/git/rebase.ts", fn: "rebaseCommand" },
      },
    },
    run: { description: "Run", module: "./commands/run.ts", fn: "runCommand" },
  };
  const specs = walkTree(tree);
  const paths = specs.map((s) => s.relPath).sort();
  expect(paths).toEqual(["git/index", "git/rebase", "run"]);
});

test("walkTree skips hidden and devOnly nodes", () => {
  const tree: Record<string, CommandNode> = {
    visible: { description: "V", module: "./commands/v.ts", fn: "run" },
    secret: { description: "S", module: "./commands/s.ts", fn: "run", hidden: true },
    dev: { description: "D", module: "./commands/d.ts", fn: "run", devOnly: true },
  };
  expect(walkTree(tree).map((s) => s.relPath)).toEqual(["visible"]);
});

test("walkTree marks a repeated node object as a non-canonical stub", () => {
  const shared: Record<string, CommandNode> = {
    sw: { description: "Switch", module: "./commands/branch.ts", fn: "switchBranch" },
  };
  const tree: Record<string, CommandNode> = {
    branch: { description: "Branch", subcommands: shared },
    git: { description: "Git", subcommands: { branch: { description: "Branch", subcommands: shared } } },
  };
  const specs = walkTree(tree);
  const canonicalSw = specs.filter((s) => s.path.at(-1) === "sw" && s.isCanonical);
  const stubSw = specs.filter((s) => s.path.at(-1) === "sw" && !s.isCanonical);
  expect(canonicalSw.length).toBe(1);
  expect(stubSw.length).toBe(1);
});
