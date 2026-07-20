import type { CommandNode } from "../../lib/command-tree.ts";

export type PageSpec = {
  relPath: string;      // under reference/, no extension, e.g. "git/rebase" or "git/index"
  path: string[];       // command path, e.g. ["git", "rebase"]
  node: CommandNode;
  isCanonical: boolean; // false when this node object was already emitted elsewhere
};

export function walkTree(tree: Record<string, CommandNode>): PageSpec[] {
  const specs: PageSpec[] = [];
  const seen = new Set<CommandNode>();

  function visit(entries: Record<string, CommandNode>, prefix: string[], relPrefix: string) {
    for (const name of Object.keys(entries)) {
      const node = entries[name];
      if (!node) continue;
      if (node.hidden || node.devOnly) continue;
      const path = [...prefix, name];
      const isBranch = !!node.subcommands && Object.keys(node.subcommands).length > 0;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const relPath = isBranch ? `${rel}/index` : rel;
      const isCanonical = !seen.has(node);
      seen.add(node);
      specs.push({ relPath, path, node, isCanonical });
      if (isBranch && isCanonical) {
        visit(node.subcommands!, path, rel);
      }
    }
  }

  visit(tree, [], "");
  return specs;
}
