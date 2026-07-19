import { test, expect } from "bun:test";
import { coverageGaps } from "../lib/docs-coverage.ts";
import type { CommandNode } from "../../lib/command-tree.ts";

test("coverageGaps lists handler leaves with no declared args", () => {
  const tree: Record<string, CommandNode> = {
    run: { description: "Run", module: "./commands/run.ts", fn: "runCommand" },
    sdm: {
      description: "SDM",
      subcommands: {
        connect: {
          description: "Connect",
          module: "./commands/sdm.ts",
          fn: "connectCmd",
          args: [{ name: "Duration", flag: "--duration", type: "text" }],
        },
      },
    },
  };
  expect(coverageGaps(tree)).toEqual(["run"]);
});
