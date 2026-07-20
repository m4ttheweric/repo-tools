import { test, expect } from "bun:test";
import { TREE } from "../command-tree-def.ts";
import { MODULE_REGISTRY } from "../module-registry.ts";
import type { CommandNode } from "../command-tree.ts";

function collectModules(tree: Record<string, CommandNode>, out: Set<string> = new Set()): Set<string> {
  for (const node of Object.values(tree)) {
    if (node.module) out.add(node.module);
    if (node.subcommands) collectModules(node.subcommands, out);
  }
  return out;
}

test("every command-tree node with a module is registered in MODULE_REGISTRY", () => {
  const modules = collectModules(TREE);
  const unregistered = [...modules].filter((m) => !(m in MODULE_REGISTRY));
  expect(unregistered).toEqual([]);
});
