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

import { bold, cyan, dim, reset, yellow } from "./tui.ts";
import { resolve, join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

// Dev mode is active when ~/.local/bin/rt exists (the wrapper script pointing
// at local source). Same detection used by commands/version.ts.
const IS_DEV_MODE = existsSync(join(homedir(), ".local/bin/rt"));
import type { RepoIdentity } from "./repo.ts";
import { MODULE_REGISTRY } from "./module-registry.ts";
import { BackNavigation } from "./rt-render.tsx";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** Resolved identity — present when the node declares context. */
  identity?: RepoIdentity;
  /** True when identity was auto-detected from cwd (not user-picked). */
  autoResolved?: boolean;
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

  /** Skip dispatcher header — command manages its own screen. */
  fullscreen?: boolean;
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
      console.error(`\n  ${yellow}unknown command: ${name}${reset}`);
      console.error(`  ${dim}available: ${Object.keys(tree).filter(k => !tree[k]!.hidden).join(", ")}${reset}\n`);
      process.exit(1);
    }

    // No args → interactive picker
    if (!process.stdin.isTTY) {
      showUsage(tree, breadcrumb);
      process.exit(0);
    }

    process.stderr.write("\x1b[2J\x1b[H");

    // At the root level, surface recent `rt run` entries at the top of the picker.
    const isRoot = breadcrumb.length === 1;
    const recentsModule = isRoot ? await import("./root-recents.ts") : null;
    const recents = recentsModule?.loadRootRecents() ?? { options: [], byValue: new Map() };

    const selected = await showPicker(tree, breadcrumb, recents.options);
    if (!selected) process.exit(0);

    if (recentsModule && selected.startsWith(recentsModule.ROOT_RECENT_PREFIX)) {
      const entry = recents.byValue.get(selected);
      if (entry) {
        await recentsModule.executeRecentEntry(entry);
        return;
      }
    }

    return dispatch(tree, [selected, ...rest], breadcrumb, baseDir);
  }

  // Node found — is it a branch or a leaf?
  const resolvedName = resolveNodeName(tree, name!);

  if (node.subcommands) {
    if (rest.length > 0) {
      // More args → try to resolve deeper
      return dispatch(node.subcommands, rest, [...breadcrumb, resolvedName], baseDir);
    }

    // Node has its own handler — run it directly when no sub-args given
    if (node.fn && node.module) {
      // Fall through to leaf execution below
    } else {
      // No more args and no own handler → show subcommand picker
      if (!process.stdin.isTTY) {
        showUsage(node.subcommands, [...breadcrumb, resolvedName]);
        process.exit(0);
      }

      process.stderr.write("\x1b[2J\x1b[H");

      const selected = await showPicker(node.subcommands, [...breadcrumb, resolvedName]);
      if (!selected) return;

      return dispatch(node.subcommands, [selected], [...breadcrumb, resolvedName], baseDir);
    }
  }

  // Leaf node → execute
  process.stderr.write("\x1b[2J\x1b[H");
  if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);

  // TTY guard — bypass when RT_BATCH=1 (called programmatically, no picker needed)
  if (node.requiresTTY && !process.stdin.isTTY && !process.env.RT_BATCH) {
    const { yellow } = await import("./tui.ts");
    const label = breadcrumb.slice(1).concat(resolvedName).join(" ");
    console.error(`\n  ${yellow}rt ${label} requires an interactive terminal${reset}\n`);
    process.exit(1);
  }

  // Context resolution
  const ctx: CommandContext = {};
  const commandLabel = breadcrumb.slice(1).concat(resolvedName).join(" ");

  // Extract --repo <name> flag if present (allows callers to pre-select the repo
  // but still trigger the worktree picker)
  let repoFlag: string | null = null;
  const repoFlagIdx = rest.indexOf("--repo");
  if (repoFlagIdx !== -1 && rest[repoFlagIdx + 1]) {
    repoFlag = rest[repoFlagIdx + 1]!;
    rest.splice(repoFlagIdx, 2);
  }

  if (node.context === "worktree") {
    const cwdBefore = process.cwd();

    if (repoFlag) {
      // --repo provided: resolve that repo and show worktree picker (skip repo picker + cwd detection)
      const { getKnownRepos, pickWorktreeFromRepo, getRepoIdentity } = await import("./repo.ts");
      const repos = getKnownRepos();
      const repo = repos.find(r => r.repoName === repoFlag);
      if (!repo) {
        const { yellow } = await import("./tui.ts");
        console.error(`\n  ${yellow}unknown repo: ${repoFlag}${reset}`);
        console.error(`  ${dim}known: ${repos.map(r => r.repoName).join(", ")}${reset}\n`);
        process.exit(1);
      }
      if (repo.worktrees.length === 1) {
        process.chdir(repo.worktrees[0]!.path);
      } else {
        const selected = await pickWorktreeFromRepo(repo, `${repoFlag} worktrees`);
        process.chdir(selected);
      }
      ctx.identity = getRepoIdentity()!;
    } else {
      const { requireIdentity } = await import("./repo.ts");
      ctx.identity = await requireIdentity(commandLabel);
    }

    if (process.cwd() !== cwdBefore) {
      process.stderr.write("\x1b[2J\x1b[H");
      if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);
    }

    // Mark auto-resolved when identity came from cwd without user interaction
    if (!repoFlag) {
      ctx.autoResolved = process.cwd() === cwdBefore;
    }
  } else if (node.context === "repo") {
    const cwdBefore = process.cwd();
    const { requireRepoIdentity } = await import("./repo.ts");
    ctx.identity = await requireRepoIdentity(commandLabel);

    if (process.cwd() !== cwdBefore) {
      process.stderr.write("\x1b[2J\x1b[H");
      if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);
    }
  }

  const handler = await resolveHandler(node, baseDir);

  // Retry loop: if the command throws BackNavigation (user picked "↩ back"),
  // go up one level — show the worktree picker for the current repo —
  // then re-run the handler with the new context.
  while (true) {
    try {
      await handler(rest, ctx);
      break;
    } catch (err) {
      if (!(err instanceof BackNavigation) || !ctx.identity) throw err;

      process.stderr.write("\x1b[2J\x1b[H");
      if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);

      const { getKnownRepos, getRepoIdentity } = await import("./repo.ts");
      const { pickWorktreeWithSwitch, pickFromAllRepos, isSwitchRepo }
        = await import("./pickers.ts");

      const repos = getKnownRepos();
      const currentRepo = repos.find(r => r.repoName === ctx.identity!.repoName);

      if (!currentRepo || currentRepo.worktrees.length <= 1) {
        // Single worktree or unknown repo — go to all repos
        const selectedPath = await pickFromAllRepos(repos);
        if (!selectedPath) process.exit(0);
        process.chdir(selectedPath);
      } else {
        // Show worktree picker with existing "↩ Switch to a different repo"
        const result = await pickWorktreeWithSwitch(
          currentRepo, ctx.identity!.repoRoot,
        );
        if (isSwitchRepo(result)) {
          const selectedPath = await pickFromAllRepos(repos);
          if (!selectedPath) process.exit(0);
          process.chdir(selectedPath);
        } else if (!result) {
          process.exit(0);
        } else {
          process.chdir(result);
        }
      }

      ctx.identity = getRepoIdentity()!;
      ctx.autoResolved = false;

      // Clear and re-run handler with new context
      process.stderr.write("\x1b[2J\x1b[H");
      if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);
      continue;
    }
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderHeader(breadcrumb: string[]): void {
  const parts = breadcrumb.map((part, i) => {
    if (i === 0) {
      const base = `${bold}${cyan}${part}${reset}`;
      return IS_DEV_MODE ? `${base} ${yellow}(dev mode)${reset}` : base;
    }
    return `${bold}${part}${reset}`;
  });
  console.error(`  ${parts.join(` ${dim}›${reset} `)}\n`);
}

function showUsage(tree: Record<string, CommandNode>, breadcrumb: string[]): void {
  renderHeader(breadcrumb);
  const visible = Object.entries(tree).filter(([_, n]) => !n.hidden);
  for (const [name, node] of visible) {
    const padded = name.padEnd(14);
    console.error(`  ${bold}${padded}${reset} ${dim}${node.description}${reset}`);
  }
  console.error("");
}

async function showPicker(
  tree: Record<string, CommandNode>,
  breadcrumb: string[],
  prepend: Array<{ value: string; label: string; hint: string }> = [],
): Promise<string | null> {
  const { filterableSelect } = await import("./rt-render.tsx");

  const visible = Object.entries(tree).filter(([_, n]) => !n.hidden);

  const selected = await filterableSelect({
    message: breadcrumb.join(" › "),
    options: [
      ...prepend,
      ...visible.map(([name, node]) => ({
        value: name,
        label: name,
        hint: node.description,
      })),
    ],
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
    // Try static registry first (required for compiled binary mode)
    const registryMod = MODULE_REGISTRY[node.module];
    if (registryMod) {
      const fn = registryMod[node.fn || "run"];
      if (typeof fn === "function") return fn;
    }

    // Fall back to dynamic import (source mode)
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
