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
