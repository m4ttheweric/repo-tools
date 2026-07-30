import { test, expect } from "bun:test";
import { TREE } from "../command-tree-def.ts";

test("TREE is importable without side effects and has expected roots", () => {
  expect(typeof TREE).toBe("object");
  // A representative slice of the built-in surface.
  for (const key of ["git", "mr", "sync", "run", "status", "sdm", "daemon"]) {
    expect(TREE[key]).toBeDefined();
    expect(typeof TREE[key]!.description).toBe("string");
  }
  expect(TREE.git!.subcommands?.rebase?.description).toContain("rebase");
});

test("branch subtree is shared by identity, not copy-pasted", () => {
  expect(TREE.branch!.subcommands).toBe(TREE.git!.subcommands!.branch!.subcommands);
});

test("commit description is consistent across both paths", () => {
  expect(TREE.commit!.description).toBe(TREE.git!.subcommands!.commit!.description);
});

test("verify command is present in the tree", () => {
  expect(TREE.verify).toBeDefined();
  expect(TREE.verify!.module).toBe("./commands/verify.ts");
});

test("sdm connections leaf exists and is agent-drivable", () => {
  const leaf = TREE.sdm!.subcommands!.connections!;
  expect(leaf.module).toBe("./commands/sdm.ts");
  expect(leaf.fn).toBe("connectionsCmd");
  expect(leaf.args!.some(a => a.flag === "--json")).toBe(true);
});

test("sdm connect carries the agent flags", () => {
  const flags = TREE.sdm!.subcommands!.connect!.args!.map(a => a.flag);
  expect(flags).toContain("--json");
  expect(flags).toContain("--confirm-production");
});
