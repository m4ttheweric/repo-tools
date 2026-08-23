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

function collectModuleFns(
  tree: Record<string, CommandNode>,
  out: Map<string, Set<string>> = new Map(),
): Map<string, Set<string>> {
  for (const node of Object.values(tree)) {
    if (node.module) {
      const fns = out.get(node.module) ?? new Set<string>();
      fns.add(node.fn || "run");
      out.set(node.module, fns);
    }
    if (node.subcommands) collectModuleFns(node.subcommands, out);
  }
  return out;
}

test("every command-tree node with a module is registered in MODULE_REGISTRY", () => {
  const modules = collectModules(TREE);
  const unregistered = [...modules].filter((m) => !(m in MODULE_REGISTRY));
  expect(unregistered).toEqual([]);
});

test("every registry entry is a lazy thunk", () => {
  for (const [key, loader] of Object.entries(MODULE_REGISTRY)) {
    expect(typeof loader).toBe("function");
  }
});

test("every registry thunk resolves to a module exporting its declared fn", async () => {
  const moduleFns = collectModuleFns(TREE);
  for (const [modulePath, fns] of moduleFns) {
    const loader = MODULE_REGISTRY[modulePath];
    expect(loader).toBeDefined();
    const mod = await loader!();
    for (const fn of fns) {
      expect(typeof (mod as any)[fn]).toBe("function");
    }
  }
});
