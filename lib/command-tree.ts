/**
 * rt command tree — Declarative command navigation with centralized UI orchestration.
 *
 * Every command registers as a node in a tree. The dispatcher handles:
 *  - Screen clearing between steps
 *  - Breadcrumb headers (rt › branch › switch)
 *  - fzf pickers for subcommand navigation
 *  - Context resolution (repo/worktree identity)
 *  - TTY guards
 *  - Lazy module loading for fast startup
 *
 * Direct args still work: `rt branch switch` traverses silently.
 * No args at a branch node → shows picker.
 */

import { bold, cyan, dim, reset } from "./tui.ts";
import { resolve } from "path";
import type { RepoIdentity } from "./repo.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** Resolved identity — present when the node declares context. */
  identity?: RepoIdentity;
}

export interface CommandNode {
  description: string;

  /** Subcommands — makes this a branch node (shows picker if no args). */
  subcommands?: Record<string, CommandNode>;

  /** Lazy module path for handler (e.g. "./commands/branch.ts"). */
  module?: string;

  /** Function name to call in the module (default: "run"). */
  fn?: string;

  /** Inline handler — overrides module/fn. */
  handler?: (args: string[], ctx: CommandContext) => Promise<void>;

  /**
   * Declare what context this command needs. Dispatcher resolves it
   * and injects it into the handler via CommandContext.
   *
   * - "repo"     → repo-level identity (repo picker only, no worktree step)
   * - "worktree" → worktree-level identity (repo → worktree picker if needed)
   * - absent     → no identity resolution
   */
  context?: "repo" | "worktree";

  /** Guard: exit early with a message if not in an interactive terminal. */
  requiresTTY?: boolean;

  /** Name aliases (e.g. ["sw"] for switch). */
  aliases?: string[];

  /** Hide from picker (still accessible by name). */
  hidden?: boolean;
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Navigate the command tree and execute the resolved handler.
 *
 * - Direct args: `rt branch switch` → resolve branch → resolve switch → execute
 * - No args at branch: show fzf picker
 * - Leaf node: clear screen, show breadcrumb, execute handler
 */
export async function dispatch(
  tree: Record<string, CommandNode>,
  args: string[],
  breadcrumb: string[] = ["rt"],
  baseDir?: string,
): Promise<void> {
  const [name, ...rest] = args;

  // No args or unknown → show picker for this level
  const node = name ? resolveNode(tree, name) : null;

  if (!node) {
    if (name) {
      // Unknown command — show help
      const { yellow } = await import("./tui.ts");
      console.log(`\n  ${yellow}unknown command: ${name}${reset}`);
      console.log(`  ${dim}available: ${Object.keys(tree).filter(k => !tree[k]!.hidden).join(", ")}${reset}\n`);
      process.exit(1);
    }

    // No args → interactive picker
    if (!process.stdin.isTTY) {
      showUsage(tree, breadcrumb);
      process.exit(0);
    }

    console.clear();

    const selected = await showPicker(tree, breadcrumb);
    if (!selected) process.exit(0);

    return dispatch(tree, [selected, ...rest], breadcrumb, baseDir);
  }

  // Node found — is it a branch or a leaf?
  const resolvedName = resolveNodeName(tree, name!);

  if (node.subcommands) {
    if (rest.length > 0) {
      // More args → try to resolve deeper
      return dispatch(node.subcommands, rest, [...breadcrumb, resolvedName], baseDir);
    }

    if (node.handler) {
      // Branch node with a default handler (e.g. `rt daemon` could show status)
      // But if it has subcommands, prefer showing the picker for discoverability
    }

    // No more args → show subcommand picker
    if (!process.stdin.isTTY) {
      showUsage(node.subcommands, [...breadcrumb, resolvedName]);
      process.exit(0);
    }

    console.clear();

    const selected = await showPicker(node.subcommands, [...breadcrumb, resolvedName]);
    if (!selected) return;

    return dispatch(node.subcommands, [selected], [...breadcrumb, resolvedName], baseDir);
  }

  // Leaf node → execute
  console.clear();
  renderHeader([...breadcrumb, resolvedName]);

  // TTY guard
  if (node.requiresTTY && !process.stdin.isTTY) {
    const { yellow } = await import("./tui.ts");
    const label = breadcrumb.slice(1).concat(resolvedName).join(" ");
    console.log(`\n  ${yellow}rt ${label} requires an interactive terminal${reset}\n`);
    process.exit(1);
  }

  // Context resolution
  const ctx: CommandContext = {};
  const commandLabel = breadcrumb.slice(1).concat(resolvedName).join(" ");

  if (node.context === "worktree") {
    const cwdBefore = process.cwd();
    const { requireIdentity } = await import("./repo.ts");
    ctx.identity = await requireIdentity(commandLabel);

    if (process.cwd() !== cwdBefore) {
      console.clear();
      renderHeader([...breadcrumb, resolvedName]);
    }
  } else if (node.context === "repo") {
    const cwdBefore = process.cwd();
    const { requireRepoIdentity } = await import("./repo.ts");
    ctx.identity = await requireRepoIdentity(commandLabel);

    if (process.cwd() !== cwdBefore) {
      console.clear();
      renderHeader([...breadcrumb, resolvedName]);
    }
  }

  const handler = await resolveHandler(node, baseDir);
  await handler(rest, ctx);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderHeader(breadcrumb: string[]): void {
  const parts = breadcrumb.map((part, i) => {
    if (i === 0) return `${bold}${cyan}${part}${reset}`;
    return `${bold}${part}${reset}`;
  });
  console.log(`  ${parts.join(` ${dim}›${reset} `)}\n`);
}

function showUsage(tree: Record<string, CommandNode>, breadcrumb: string[]): void {
  renderHeader(breadcrumb);
  const visible = Object.entries(tree).filter(([_, n]) => !n.hidden);
  for (const [name, node] of visible) {
    const padded = name.padEnd(14);
    console.log(`  ${bold}${padded}${reset} ${dim}${node.description}${reset}`);
  }
  console.log("");
}

async function showPicker(
  tree: Record<string, CommandNode>,
  breadcrumb: string[],
): Promise<string | null> {
  const { filterableSelect } = await import("./rt-render.tsx");

  const visible = Object.entries(tree).filter(([_, n]) => !n.hidden);

  const selected = await filterableSelect({
    message: breadcrumb.join(" › "),
    options: visible.map(([name, node]) => ({
      value: name,
      label: name,
      hint: node.description,
    })),
  });

  return selected || null;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

function resolveNode(tree: Record<string, CommandNode>, name: string): CommandNode | null {
  // Direct match
  if (tree[name]) return tree[name]!;

  // Alias match
  for (const [key, node] of Object.entries(tree)) {
    if (node.aliases?.includes(name)) return node;
  }

  return null;
}

function resolveNodeName(tree: Record<string, CommandNode>, name: string): string {
  if (tree[name]) return name;

  for (const [key, node] of Object.entries(tree)) {
    if (node.aliases?.includes(name)) return key;
  }

  return name;
}

async function resolveHandler(node: CommandNode, baseDir?: string): Promise<(args: string[], ctx: CommandContext) => Promise<void>> {
  if (node.handler) return node.handler;

  if (node.module) {
    const modulePath = baseDir ? resolve(baseDir, node.module) : node.module;
    const mod = await import(modulePath);
    const fn = mod[node.fn || "run"];
    if (typeof fn !== "function") {
      throw new Error(`Module ${node.module} does not export "${node.fn || "run"}"`);
    }
    return fn;
  }

  throw new Error("CommandNode has no handler or module");
}
