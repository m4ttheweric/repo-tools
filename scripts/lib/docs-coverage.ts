import type { CommandNode } from "../../lib/command-tree.ts";
import { walkTree } from "./docs-walk.ts";

export function coverageGaps(tree: Record<string, CommandNode>): string[] {
  return walkTree(tree)
    .filter((s) => s.isCanonical)
    .filter((s) => s.node.module && (!s.node.args || s.node.args.length === 0))
    .map((s) => s.path.join(" "))
    .sort();
}
