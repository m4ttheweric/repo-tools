import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { dispatch, type CommandNode } from "../command-tree.ts";
import { toCommandNode } from "../plugins.ts";

const noop = async () => {};

function makeTree(onRun?: (args: string[]) => void): Record<string, CommandNode> {
  return {
    daemon: {
      description: "Manage the daemon",
      subcommands: {
        status: { description: "Show daemon status", handler: noop },
        logs: { description: "View logs", handler: noop },
        secret: { description: "Hidden verb", hidden: true, handler: noop },
        lab: { description: "Dev-only verb", devOnly: true, handler: noop },
      },
    },
    join: {
      description: "Join a room",
      aliases: ["j"],
      args: [
        { name: "Room", type: "text", hint: "room to join" },
        { name: "Handle", flag: "--as", type: "text", hint: "post as this handle" },
        { name: "Force", flag: "--force", type: "boolean", hint: "skip confirmation" },
      ],
      handler: async (args) => onRun?.(args),
    },
    run: {
      description: "Run things",
      module: "./commands/fake.ts",
      fn: "run",
      handler: async (args) => onRun?.(args),
      subcommands: {
        once: { description: "Run once", handler: noop },
      },
    },
  };
}

let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit sentinel");
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

const stdout = () => logSpy.mock.calls.flat().join("\n");

describe("branch --help", () => {
  test("prints subcommand names and descriptions to stdout, exits 0", async () => {
    await expect(dispatch(makeTree(), ["daemon", "--help"])).rejects.toThrow("exit sentinel");
    expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(0);
    expect(stdout()).toContain("status");
    expect(stdout()).toContain("Show daemon status");
    expect(stdout()).toContain("logs");
  });

  test("root --help lists top-level commands", async () => {
    await expect(dispatch(makeTree(), ["--help"])).rejects.toThrow("exit sentinel");
    expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(0);
    expect(stdout()).toContain("daemon");
    expect(stdout()).toContain("Manage the daemon");
  });

  test("hidden subcommands are excluded; devOnly follows dev-mode detection", async () => {
    const isDev = existsSync(join(homedir(), ".local/bin/rt"));
    await expect(dispatch(makeTree(), ["daemon", "-h"])).rejects.toThrow("exit sentinel");
    expect(stdout()).not.toContain("secret");
    expect(stdout().includes("lab")).toBe(isDev);
  });
});

describe("leaf --help", () => {
  test("prints usage from args metadata, description, aliases; handler not called", async () => {
    let ran = false;
    const tree = makeTree(() => { ran = true; });
    await expect(dispatch(tree, ["join", "--help"])).rejects.toThrow("exit sentinel");
    expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(0);
    expect(ran).toBe(false);
    const out = stdout();
    expect(out).toContain("rt join <room>");
    expect(out).toContain("--as");
    expect(out).toContain("--force");
    expect(out).toContain("Join a room");
    expect(out).toContain("aliases: j");
    expect(out).toContain("room to join");
  });

  test("-h behaves the same as --help", async () => {
    let ran = false;
    const tree = makeTree(() => { ran = true; });
    await expect(dispatch(tree, ["join", "-h"])).rejects.toThrow("exit sentinel");
    expect(ran).toBe(false);
    expect(stdout()).toContain("rt join <room>");
  });

  test("only intercepts as the first arg: later --help reaches the handler", async () => {
    let captured: string[] | undefined;
    const tree = makeTree((args) => { captured = args; });
    await dispatch(tree, ["join", "myroom", "--help"]);
    expect(captured).toEqual(["myroom", "--help"]);
  });

  test("context node --help renders without resolving identity", async () => {
    const tree: Record<string, CommandNode> = {
      cmd: { description: "needs a worktree", context: "worktree", handler: noop },
    };
    await expect(dispatch(tree, ["cmd", "--help"])).rejects.toThrow("exit sentinel");
    expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(0);
    expect(stdout()).toContain("needs a worktree");
  });

  test("help output carries no ANSI when stdout is not a TTY", async () => {
    await expect(dispatch(makeTree(), ["join", "--help"])).rejects.toThrow("exit sentinel");
    if (!process.stdout.isTTY) expect(stdout()).not.toContain("\x1b[");
  });
});

describe("branch+handler --help", () => {
  test("shows own usage plus subcommand listing; handler not called", async () => {
    let ran = false;
    const tree = makeTree(() => { ran = true; });
    await expect(dispatch(tree, ["run", "--help"])).rejects.toThrow("exit sentinel");
    expect(ran).toBe(false);
    const out = stdout();
    expect(out).toContain("Run things");
    expect(out).toContain("once");
    expect(out).toContain("Run once");
  });
});

describe("passThroughHelp", () => {
  test("a passThroughHelp leaf receives --help as an ordinary arg", async () => {
    let captured: string[] | undefined;
    const tree: Record<string, CommandNode> = {
      wrapped: {
        description: "exec wrapper",
        passThroughHelp: true,
        handler: async (args) => { captured = args; },
      },
    };
    await dispatch(tree, ["wrapped", "--help"]);
    expect(captured).toEqual(["--help"]);
  });

  test("toCommandNode marks exec plugin nodes passThroughHelp", () => {
    const node = toCommandNode("p", "/tmp/p", { description: "x", exec: "echo" });
    expect(node.passThroughHelp).toBe(true);
  });

  test("toCommandNode leaves module plugin nodes intercepted", () => {
    const node = toCommandNode("p", "/tmp/p", { description: "x", module: "./m.ts" });
    expect(node.passThroughHelp).toBeUndefined();
  });
});
