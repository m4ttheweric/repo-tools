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
 * ctrl-up at a subtree picker goes up one tree level (root picker exits,
 * same as Esc). Tree back-nav never crosses into a running command.
 */

import { bold, cyan, dim, reset, yellow } from "./tui.ts";
import { spawnSync } from "child_process";
import { resolve, join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { beginCommand, logCommand } from "./cli-logger.ts";
import { toHex, T } from "./tui/palette.ts";

// Dev mode is active when ~/.local/bin/rt exists (the wrapper script pointing
// at local source). Same detection used by commands/version.ts.
const IS_DEV_MODE = existsSync(join(homedir(), ".local/bin/rt"));
import type { RepoIdentity } from "./repo.ts";
import { MODULE_REGISTRY } from "./module-registry.ts";
import { BackNavigation } from "./rt-render.tsx";
import type { SelectOption } from "./rt-render.tsx";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** Resolved identity — present when the node declares context. */
  identity?: RepoIdentity;
  /** True when identity was auto-detected from cwd (not user-picked). */
  autoResolved?: boolean;
}

export interface CommandArg {
  /** Display name shown as the prompt label (e.g. "Duration", "Dry run"). */
  name: string;
  /** CLI flag (e.g. "--force", "--duration"). Omit for positional args. */
  flag?: string;
  /** Input type: text input, yes/no toggle, or pick from a list. */
  type: "text" | "boolean" | "select";
  /** Description shown as a hint below the prompt. */
  hint?: string;
  /** Placeholder text for text inputs. */
  placeholder?: string;
  /** Default value (string for text/select, boolean for boolean). */
  default?: string | boolean;
  /** Options for select type. */
  options?: SelectOption[];
}

export interface CommandNode {
  description: string;

  /** Subcommands — makes this a branch node (shows picker if no args). */
  subcommands?: Record<string, CommandNode>;

  /** Lazy module path for handler (e.g. "./commands/sync.ts"). */
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

  /**
   * Dev-mode only: hidden from pickers/usage AND unrunnable unless dev mode is
   * active (~/.local/bin/rt wrapper present), so experimental commands can live
   * in the tree without shipping in the compiled binary's surface.
   */
  devOnly?: boolean;

  /** Skip dispatcher header — command manages its own screen. */
  fullscreen?: boolean;

  /**
   * Declared arguments. When present, alt-enter at the picker opens an
   * interactive form to collect them before calling the handler.
   */
  args?: CommandArg[];
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
  rootTree?: Record<string, CommandNode>,
  withArgs?: boolean,
): Promise<void> {
  // The root tree is threaded through recursion so picker back-nav can derive
  // any parent level from the breadcrumb alone (works even when the user
  // arrived via direct args and never saw the parent picker).
  const root = rootTree ?? tree;
  const [name, ...rest] = args;

  // No args or unknown → show picker for this level
  let node = name ? resolveNode(tree, name) : null;
  // Dev-only commands are invisible AND unrunnable outside dev mode: null the
  // node so it falls into the unknown-command path, and isNodeVisible keeps it
  // out of pickers/usage. The compiled binary never exposes them.
  if (node && node.devOnly && !IS_DEV_MODE) node = null;

  if (!node) {
    if (name) {
      // Unknown command — show help
      const { yellow } = await import("./tui.ts");
      console.error(`\n  ${yellow}unknown command: ${name}${reset}`);
      console.error(`  ${dim}available: ${Object.keys(tree).filter(k => isNodeVisible(tree[k]!, IS_DEV_MODE)).join(", ")}${reset}\n`);
      process.exit(1);
    }

    // No args → interactive picker
    if (!process.stdin.isTTY) {
      showUsage(tree, breadcrumb);
      process.exit(0);
    }

    process.stderr.write("\x1b[2J\x1b[H");

    const picked = await showPicker(tree, breadcrumb);
    if (picked === BACK) {
      const parentBreadcrumb = breadcrumb.slice(0, -1);
      const parentTree = walkTree(root, parentBreadcrumb.slice(1));
      if (!parentTree) throw new Error(`cannot resolve parent tree for: ${breadcrumb.join(" › ")}`);
      return dispatch(parentTree, [], parentBreadcrumb, baseDir, root);
    }
    if (!picked) process.exit(0);

    return dispatch(tree, [picked.command, ...rest], breadcrumb, baseDir, root, picked.withArgs);
  }

  // Node found — is it a branch or a leaf?
  const resolvedName = resolveNodeName(tree, name!);

  if (node.subcommands) {
    // Only recurse into subcommands when the next arg actually matches one.
    // This lets a node with both a handler and subcommands receive flags
    // (e.g. `rt run --print`) without them being mis-parsed as subcommands.
    const firstArg = rest[0];
    const firstMatchesSub = firstArg ? !!resolveNode(node.subcommands, firstArg) : false;
    const nodeHasHandler = !!(node.fn && node.module);

    if (rest.length > 0 && (firstMatchesSub || !nodeHasHandler)) {
      // Recurse: either the arg is a known subcommand, or this node has no
      // handler of its own so any arg must be a subcommand (yields the usual
      // "unknown command" message if it's bogus).
      return dispatch(node.subcommands, rest, [...breadcrumb, resolvedName], baseDir, root, withArgs);
    }

    // Node has its own handler — run it directly, passing rest through as args
    if (nodeHasHandler) {
      // Fall through to leaf execution below
    } else {
      // No more args and no own handler → show subcommand picker
      if (!process.stdin.isTTY) {
        showUsage(node.subcommands, [...breadcrumb, resolvedName]);
        process.exit(0);
      }

      process.stderr.write("\x1b[2J\x1b[H");

      const picked = await showPicker(node.subcommands, [...breadcrumb, resolvedName]);
      if (picked === BACK) return dispatch(tree, [], breadcrumb, baseDir, root);
      if (!picked) return;

      return dispatch(node.subcommands, [picked.command], [...breadcrumb, resolvedName], baseDir, root, picked.withArgs);
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
  beginCommand(commandLabel, rest);

  if (node.context === "worktree") {
    const cwdBefore = process.cwd();

    // Extract --repo <name> flag if present (allows callers to pre-select the repo
    // but still trigger the worktree picker). Scoped to context:"worktree" nodes
    // only — a node without this context (e.g. the daemon-backed worktree
    // lifecycle verbs, which take their own `--repo <registeredName>` payload
    // flag) must see `--repo` untouched in its own args, not have it silently
    // consumed here.
    let repoFlag: string | null = null;
    const repoFlagIdx = rest.indexOf("--repo");
    if (repoFlagIdx !== -1 && rest[repoFlagIdx + 1]) {
      repoFlag = rest[repoFlagIdx + 1]!;
      rest.splice(repoFlagIdx, 2);
    }

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
        if (!selected) process.exit(0); // Esc on worktree picker
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

  // alt-enter at the picker: collect declared args interactively
  if (withArgs && node.args?.length && process.stdin.isTTY) {
    const { collectArgs } = await import("./arg-collector.tsx");
    const formLabel = [...breadcrumb, resolvedName].join(" ");
    const collected = await collectArgs(formLabel, node.args);
    if (collected === null) process.exit(0);
    rest.push(...collected);

    process.stderr.write("\x1b[2J\x1b[H");
    if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);
  }

  const handler = await resolveHandler(node, baseDir);

  // Retry loop: if the command throws BackNavigation (user pressed ctrl-up),
  // go up one level — show the worktree picker for the current repo —
  // then re-run the handler with the new context.
  while (true) {
    const t0 = Date.now();
    try {
      await handler(rest, ctx);
      logCommand({
        command: commandLabel,
        args: rest,
        cwd: process.cwd(),
        repo: ctx.identity?.repoName,
        durationMs: Date.now() - t0,
        outcome: "ok",
      });
      break;
    } catch (err) {
      if (!(err instanceof BackNavigation) || !ctx.identity) {
        logCommand({
          command: commandLabel,
          args: rest,
          cwd: process.cwd(),
          repo: ctx.identity?.repoName,
          durationMs: Date.now() - t0,
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        throw err;
      }

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

/** Visible in pickers/usage: not hidden, and (dev-only nodes) only in dev mode. */
export function isNodeVisible(node: CommandNode, isDev: boolean): boolean {
  return !node.hidden && (!node.devOnly || isDev);
}

function showUsage(tree: Record<string, CommandNode>, breadcrumb: string[]): void {
  renderHeader(breadcrumb);
  const visible = Object.entries(tree).filter(([_, n]) => isNodeVisible(n, IS_DEV_MODE));
  for (const [name, node] of visible) {
    const padded = name.padEnd(14);
    console.error(`  ${bold}${padded}${reset} ${dim}${node.description}${reset}`);
  }
  console.error("");
}

/** Sentinel: the user pressed ctrl-up at a subtree picker. */
const BACK: unique symbol = Symbol("back");

interface PickerSelection {
  command: string;
  withArgs: boolean;
}

async function showPicker(
  tree: Record<string, CommandNode>,
  breadcrumb: string[],
): Promise<PickerSelection | typeof BACK | null> {
  const { ensureFzf } = await import("./fzf.ts");
  ensureFzf();

  const visible = Object.entries(tree).filter(([_, n]) => isNodeVisible(n, IS_DEV_MODE));
  const anyHasArgs = visible.some(([_, n]) => n.args?.length);

  const labelWidth = Math.max(...visible.map(([name]) => name.length));
  const input = visible
    .map(([name, node]) => {
      const pad = " ".repeat(labelWidth - name.length);
      return `${name}\t\x1b[1m${name}\x1b[22m${pad}\t  \x1b[2m${node.description}\x1b[22m`;
    })
    .join("\n");

  const headerParts = ["enter: select", "|: OR", "!: exclude"];
  if (breadcrumb.length > 1) headerParts.push("ctrl-up: back");
  if (anyHasArgs) headerParts.push("alt-enter: with args");

  const expectKeys = ["ctrl-up"];
  if (anyHasArgs) expectKeys.push("alt-enter");

  const result = spawnSync("fzf", [
    "--ansi",
    "--with-nth=2..",
    "--nth=1",
    "--delimiter=\t",
    "--tabstop=1",
    process.env.RT_FZF_ALT_SCREEN ? "--height=100%" : "--height=~100%",
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${breadcrumb.join(" › ")} `,
    "--prompt=filter: ",
    `--header=${headerParts.join("  ")}`,
    "--no-mouse",
    "--print-query",
    `--expect=${expectKeys.join(",")}`,
    `--color=border:${toHex(T.pink)},label:${toHex(T.pink)}`,
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  // fzf exits 1 ("no match") when an --expect key is pressed while no item is
  // matched -- the list is still loading from stdin, or the query matches
  // nothing. The query and key lines are still printed, and back-navigation
  // doesn't depend on a selection existing, so read the key before consulting
  // the exit status; otherwise a ctrl-up during list load or on an empty
  // filter is silently rewritten into a cancel and rt exits instead of going
  // back. Anything else non-zero (130 = Esc/ctrl-c abort, 2 = error) is a
  // real cancel.
  if (result.status !== 0 && result.status !== 1) return null;

  const lines = (result.stdout ?? "").split("\n");
  const key = lines[1]?.trim() || "";
  const raw = lines[2]?.trim() ?? "";
  const value = raw.split("\t")[0] || null;

  if (key === "ctrl-up") {
    return breadcrumb.length > 1 ? BACK : null;
  }

  if (result.status !== 0 || !value) return null;

  return { command: value, withArgs: key === "alt-enter" };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Walk from the root tree down a path of canonical node names (a breadcrumb
 * minus the leading "rt"), returning that level's subcommand map.
 * Returns null if any segment is missing or isn't a branch node.
 */
export function walkTree(
  root: Record<string, CommandNode>,
  path: string[],
): Record<string, CommandNode> | null {
  let current: Record<string, CommandNode> | undefined = root;
  for (const name of path) {
    current = current ? resolveNode(current, name)?.subcommands : undefined;
  }
  return current ?? null;
}

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
