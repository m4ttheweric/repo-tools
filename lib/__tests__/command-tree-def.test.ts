import { test, expect } from "bun:test";
import { TREE } from "../command-tree-def.ts";
import { renderUsage } from "../../scripts/lib/docs-render.ts";

test("TREE is importable without side effects and has expected roots", () => {
  expect(typeof TREE).toBe("object");
  // A representative slice of the built-in surface.
  for (const key of ["git", "sync", "run", "update", "sdm", "daemon"]) {
    expect(TREE[key]).toBeDefined();
    expect(typeof TREE[key]!.description).toBe("string");
  }
  expect(TREE.git!.subcommands?.rebase?.description).toContain("rebase");
});

test("commit description is consistent across both paths", () => {
  expect(TREE.commit!.description).toBe(TREE.git!.subcommands!.commit!.description);
  // Shared by identity, not copy-pasted — a divergence here means the tree
  // was edited to duplicate commitNode instead of reusing the constant.
  expect(TREE.commit).toBe(TREE.git!.subcommands!.commit);
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

test("worktree restore's Tree arg is marked optional, matching its picker/--list omission", () => {
  const restore = TREE.worktree!.subcommands!.restore!;
  expect(restore.omitBehavior).toBe("picker");
  const treeArg = restore.args!.find(a => a.name === "Tree")!;
  expect(treeArg.optional).toBe(true);
  expect(renderUsage(["worktree", "restore"], restore.args)).toContain("rt worktree restore [<tree>] [flags]");
});

test("picker-hosting leaves suppress the dispatcher header (fullscreen), like run", () => {
  expect(TREE.run!.fullscreen).toBe(true); // existing reference case
  expect(TREE.commit!.fullscreen).toBe(true);
  expect(TREE.cd!.fullscreen).toBe(true);
  expect(TREE.nav!.fullscreen).toBe(true);
  expect(TREE.skills!.subcommands!.surface!.fullscreen).toBe(true);
});

test("the bare skills branch node is not flagged fullscreen -- only the surface leaf is", () => {
  expect(TREE.skills!.fullscreen).toBeUndefined();
  expect(TREE.skills!.subcommands!.check!.fullscreen).toBeUndefined();
  expect(TREE.skills!.subcommands!.compile!.fullscreen).toBeUndefined();
});
