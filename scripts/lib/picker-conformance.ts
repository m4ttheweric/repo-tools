/**
 * The picker-convention gate: every leaf that requires a positional argument
 * must declare what it does when that argument is omitted in a TTY (its
 * `omitBehavior`). The dispatcher already guarantees the *subcommand* picker
 * for branch nodes; this covers the other half of the convention — the
 * per-handler *argument* picker — which lives in each command and so cannot be
 * enforced structurally. Making the intent an explicit, checked declaration is
 * what keeps a new command (or a regressed one) from silently erroring where a
 * picker was expected.
 *
 * Consumed by lib/__tests__/picker-conformance.test.ts (the CI gate) and
 * printable standalone: `bun scripts/lib/picker-conformance.ts`.
 */
import type { CommandNode, OmitBehavior } from "../../lib/command-tree.ts";

export interface LeafSpec {
  path: string[];
  node: CommandNode;
  /** Names of the required (flagless, non-optional) positional args. */
  positionals: string[];
}

/** Every visible leaf that requires at least one positional argument. */
export function requiredPositionalLeaves(
  tree: Record<string, CommandNode>,
): LeafSpec[] {
  const out: LeafSpec[] = [];
  const seen = new Set<CommandNode>();

  function visit(entries: Record<string, CommandNode>, prefix: string[]): void {
    for (const [name, node] of Object.entries(entries)) {
      if (!node || node.hidden || node.devOnly) continue;
      // A node object shared across two paths (e.g. commitNode) is one command;
      // classify it once, under the path it is first reached by.
      if (seen.has(node)) continue;
      seen.add(node);

      const path = [...prefix, name];
      const hasHandler = !!(node.handler || (node.module && node.fn));
      const positionals = (node.args ?? [])
        .filter((a) => !a.flag && !a.optional && (a.type === "text" || a.type === "select"))
        .map((a) => a.name);

      if (hasHandler && positionals.length > 0) out.push({ path, node, positionals });
      if (node.subcommands) visit(node.subcommands, path);
    }
  }

  visit(tree, []);
  return out;
}

export function isValidOmitBehavior(v: unknown): v is OmitBehavior {
  if (v === "picker" || v === "list" || v === "prompt") return true;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { exempt?: unknown }).exempt === "string" &&
    (v as { exempt: string }).exempt.trim().length > 0
  );
}

export interface Violation {
  path: string;
  positionals: string[];
  reason: "missing" | "invalid";
}

export function conformanceViolations(
  tree: Record<string, CommandNode>,
): Violation[] {
  const out: Violation[] = [];
  for (const { path, node, positionals } of requiredPositionalLeaves(tree)) {
    const ob = node.omitBehavior;
    if (ob === undefined) out.push({ path: path.join(" "), positionals, reason: "missing" });
    else if (!isValidOmitBehavior(ob)) out.push({ path: path.join(" "), positionals, reason: "invalid" });
  }
  return out;
}

// Standalone print: the current in-scope set and each leaf's declared behavior.
if (import.meta.main) {
  const { TREE } = await import("../../lib/command-tree-def.ts");
  const leaves = requiredPositionalLeaves(TREE);
  for (const { path, node, positionals } of leaves) {
    const ob = node.omitBehavior;
    const tag = ob === undefined ? "— UNDECLARED —" : typeof ob === "string" ? ob : `exempt: ${ob.exempt}`;
    console.log(`${`rt ${path.join(" ")}`.padEnd(28)} [${positionals.join(", ")}]  ${tag}`);
  }
  const v = conformanceViolations(TREE);
  console.log(`\n${leaves.length} in-scope leaf/leaves, ${v.length} violation(s)`);
}
