import { describe, test, expect } from "bun:test";
import { validateManifest } from "../plugins.ts";

const valid = {
  name: "my-plugin",
  apiVersion: 1,
  commands: {
    standup: {
      description: "Draft my standup",
      module: "./standup.ts",
      aliases: ["su"],
      context: "worktree",
      args: [{ name: "Team", flag: "--team", type: "select", options: [{ value: "cv", label: "cv" }] }],
    },
    notes: {
      description: "Scratch notes",
      subcommands: {
        add: { description: "Add a note", module: "./notes.ts", fn: "add" },
      },
    },
    deploy: { description: "Deploy", exec: "./scripts/deploy.sh" },
    lint: { description: "Lint", exec: ["bash", "-c", "echo hi"] },
  },
};

describe("validateManifest", () => {
  test("accepts a full valid manifest", () => {
    expect(validateManifest(valid)).toEqual([]);
  });

  test("rejects non-object / missing basics", () => {
    expect(validateManifest(null).length).toBeGreaterThan(0);
    expect(validateManifest({}).length).toBeGreaterThan(0);
    expect(validateManifest({ name: "x", apiVersion: 1, commands: {} })).toEqual([
      "commands: must declare at least one command",
    ]);
  });

  test("rejects wrong apiVersion", () => {
    const errors = validateManifest({ ...valid, apiVersion: 2 });
    expect(errors.join()).toContain("apiVersion");
  });

  test("rejects non-kebab-case name", () => {
    expect(validateManifest({ ...valid, name: "My Plugin" }).join()).toContain("kebab-case");
  });

  test("rejects unknown fields at every level", () => {
    expect(validateManifest({ ...valid, extra: 1 }).join()).toContain('unknown field "extra"');
    const cmds = { bad: { description: "x", module: "./x.ts", modle: "typo" } };
    expect(validateManifest({ ...valid, commands: cmds }).join()).toContain('unknown field "modle"');
  });

  test("requires exactly one of module/exec/subcommands", () => {
    const both = { name: "p", apiVersion: 1, commands: { a: { description: "d", module: "./a.ts", exec: "./a.sh" } } };
    expect(validateManifest(both).join()).toContain("exactly one");
    const none = { name: "p", apiVersion: 1, commands: { a: { description: "d" } } };
    expect(validateManifest(none).join()).toContain("exactly one");
    const modPlusSub = {
      name: "p", apiVersion: 1,
      commands: { a: { description: "d", module: "./a.ts", subcommands: { b: { description: "e", module: "./b.ts" } } } },
    };
    expect(validateManifest(modPlusSub).join()).toContain("exactly one");
  });

  test("rejects fn without module and bad arg entries", () => {
    const fnNoModule = { name: "p", apiVersion: 1, commands: { a: { description: "d", exec: "./a.sh", fn: "run" } } };
    expect(validateManifest(fnNoModule).join()).toContain('"fn" requires "module"');
    const badArg = { name: "p", apiVersion: 1, commands: { a: { description: "d", module: "./a.ts", args: [{ name: "X", type: "nope" }] } } };
    expect(validateManifest(badArg).join()).toContain("args[0]");
  });

  test("validates nested subcommands recursively", () => {
    const nested = {
      name: "p", apiVersion: 1,
      commands: { a: { description: "d", subcommands: { b: { description: "e" } } } },
    };
    expect(validateManifest(nested).join()).toContain("a.b");
  });
});
