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
  expect(TREE.nav!.fullscreen).toBe(true);
  expect(TREE.skills!.subcommands!.surface!.fullscreen).toBe(true);
  // cd's picker (routed through lib/pickers.ts) carries its own in-card
  // breadcrumb, so its dispatcher header is suppressed too.
  expect(TREE.cd!.fullscreen).toBe(true);
});

test("the five worktree leaves that open a picker suppress the dispatcher header (fullscreen)", () => {
  const wt = TREE.worktree!.subcommands!;
  for (const leaf of ["dispose", "restore", "ready-approve", "freshen", "await-ready"]) {
    expect(wt[leaf]!.fullscreen).toBe(true);
  }
  // provision has no interactive picker of its own today -- suppressing its
  // header would drop it with nothing to carry the context instead.
  // create/list/adopt/each/hook/claude-hook aren't in scope either -- they
  // never show a picker or aren't leaf-argument pickers at all.
  expect(wt.provision!.fullscreen).toBeUndefined();
  expect(wt.create!.fullscreen).toBeUndefined();
  expect(wt.list!.fullscreen).toBeUndefined();
});

test("the bare skills branch node is not flagged fullscreen -- only the surface leaf is", () => {
  expect(TREE.skills!.fullscreen).toBeUndefined();
  expect(TREE.skills!.subcommands!.check!.fullscreen).toBeUndefined();
  expect(TREE.skills!.subcommands!.compile!.fullscreen).toBeUndefined();
});

test("runs stage-redirect is a registered leaf with its three flags, so it never falls through to the list", () => {
  const leaf = TREE.runs!.subcommands!["stage-redirect"]!;
  expect(leaf.module).toBe("./commands/runs-write.ts");
  expect(leaf.fn).toBe("runsStageRedirect");
  expect(leaf.args!.map((a) => a.flag)).toEqual(["--stage", "--to", "--reason"]);
  expect(leaf.args!.every((a) => a.flag)).toBe(true);
});
