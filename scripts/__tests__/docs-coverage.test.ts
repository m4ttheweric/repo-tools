import { test, expect } from "bun:test";
import { coverageGaps } from "../lib/docs-coverage.ts";
import type { CommandNode } from "../../lib/command-tree.ts";

test("coverageGaps lists handler leaves whose args are undefined", () => {
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

test("coverageGaps treats args:[] as reviewed-empty, not a gap", () => {
  const tree: Record<string, CommandNode> = {
    // undefined args → still a gap
    port: { description: "Port", module: "./commands/port.ts", fn: "portScanner" },
    // reviewed, genuinely no user flags → NOT a gap
    version: { description: "Version", module: "./commands/version.ts", fn: "runVersion", args: [] },
    // reviewed, has flags → NOT a gap
    login: {
      description: "Login",
      module: "./commands/sdm.ts",
      fn: "loginCmd",
      args: [{ name: "Manual", flag: "--manual", type: "boolean" }],
    },
  };
  expect(coverageGaps(tree)).toEqual(["port"]);
});
