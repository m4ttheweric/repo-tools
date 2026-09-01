/**
 * rt command tree — Declarative command navigation with centralized UI orchestration.
 *
 * Every command registers as a node in a tree. The dispatcher handles:
 *  - Screen clearing between steps
 *  - Breadcrumb headers (rt › daemon › status)
 *  - fzf pickers for subcommand navigation
 *  - Context resolution (repo/worktree identity)
 *  - TTY guards
 *  - Lazy module loading for fast startup
 *
 * Direct args still work: `rt daemon status` traverses silently.
 * No args at a branch node → shows picker.
 * ctrl-up at a subtree picker goes up one tree level (root picker exits,
 * same as Esc). Tree back-nav never crosses into a running command.
 */

import { bold, cyan, dim, reset, yellow } from "./tui.ts";
import { resolve, join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { beginCommand, logCommand } from "./cli-logger.ts";
import type { PickAction, PickRow } from "./ui/protocol.ts";

// Dev mode is active when ~/.local/bin/rt exists (the wrapper script pointing
// at local source). Same detection used by commands/version.ts.
const IS_DEV_MODE = existsSync(join(homedir(), ".local/bin/rt"));
import type { RepoIdentity } from "./repo.ts";
import { MODULE_REGISTRY } from "./module-registry.ts";
import { BackNavigation } from "./back-navigation.ts";
import type { SelectOption } from "./rt-render.ts";

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
  /** A positional that some verbs of this command take and others do not;
      rendered as `[<name>]` in the reference usage line. */
  optional?: boolean;
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

  /**
   * Guard: exit early with a message if not in an interactive terminal.
   * A function form is evaluated against the leaf's own args (e.g. a node
   * only needs a TTY to prompt for an arg the caller could instead supply
   * directly — see `settings dev-mode`'s Target).
   */
  requiresTTY?: boolean | ((args: string[]) => boolean);

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

  /**
   * Leaf wraps an external binary that owns its own --help (plugin exec
   * targets): forward the flag as an ordinary arg instead of intercepting.
   */
  passThroughHelp?: boolean;

  /**
   * What this leaf does when its required positional is omitted in a TTY.
   * The picker-conformance gate (lib/__tests__/picker-conformance.test.ts)
   * requires every leaf with a required positional to declare one — the
   * "omit args → interactive affordance" convention made explicit and
   * checkable, since the behavior lives in the handler, not the dispatcher.
   *
   *  - "picker" → an fzf/ink picker over a listable set (the default shape)
   *  - "list"   → prints the set; the no-arg call is itself a useful read
   *  - "prompt" → a free-text / no-echo interactive prompt for the value
   *  - { exempt } → deliberately errors instead; the reason is documented here
   *    and reviewed, for values that cannot be enumerated (free-text commands,
   *    brand-new paths) or verbs that must be pointed at explicitly.
   */
  omitBehavior?: OmitBehavior;
}

/** See CommandNode.omitBehavior. */
export type OmitBehavior = "picker" | "list" | "prompt" | { exempt: string };

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Navigate the command tree and execute the resolved handler.
 *
 * - Direct args: `rt daemon status` → resolve daemon → resolve status → execute
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

  if (name && HELP_FLAGS.has(name)) {
    printBranchHelp(tree, breadcrumb, root);
    process.exit(0);
  }

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

    clearScreen();

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

      clearScreen();

      const picked = await showPicker(node.subcommands, [...breadcrumb, resolvedName]);
      if (picked === BACK) return dispatch(tree, [], breadcrumb, baseDir, root);
      if (!picked) return;

      return dispatch(node.subcommands, [picked.command], [...breadcrumb, resolvedName], baseDir, root, picked.withArgs);
    }
  }

  // --help as the FIRST remaining arg only — a later token may be a flag's
  // value (e.g. `pane send x --text --help`), which must reach the handler.
  if (rest[0] && HELP_FLAGS.has(rest[0]) && !node.passThroughHelp) {
    printLeafHelp(node, [...breadcrumb, resolvedName]);
    process.exit(0);
  }

  // Leaf node → execute
  clearScreen();
  if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);

  // TTY guard — bypass when RT_BATCH=1 (called programmatically, no picker needed)
  const needsTTY = typeof node.requiresTTY === "function" ? node.requiresTTY(rest) : node.requiresTTY;
  if (needsTTY && !process.stdin.isTTY && !process.env.RT_BATCH) {
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
      const { getKnownRepos, pickWorktreeFromRepo, getRepoIdentity, missingRepoRefusal } = await import("./repo.ts");
      const repos = getKnownRepos({ includeMissing: true });
      const repo = repos.find(r => r.repoName === repoFlag);
      if (!repo) {
        const { yellow } = await import("./tui.ts");
        console.error(`\n  ${yellow}unknown repo: ${repoFlag}${reset}`);
        const { repoLabel } = await import("./repo-label.ts");
        console.error(`  ${dim}known: ${repos.map(r => repoLabel(r.repoName)).join(", ")}${reset}\n`);
        process.exit(1);
      }
      // A missing row still resolves by name (that's the point — locate it),
      // but its one synthetic worktree is a dead path: never chdir into it.
      if (repo.missing) {
        console.error(`\n  ${missingRepoRefusal(repo)}\n`);
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
      clearScreen();
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
      clearScreen();
      if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);
    }
  }

  // alt-enter at the picker: collect declared args interactively
  if (withArgs && node.args?.length && process.stdin.isTTY) {
    const { collectArgs } = await import("./arg-collector.ts");
    const formLabel = [...breadcrumb, resolvedName].join(" ");
    const collected = await collectArgs(formLabel, node.args);
    if (collected === null) process.exit(0);
    rest.push(...collected);

    clearScreen();
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

      clearScreen();
      if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);

      const { getKnownRepos, getRepoIdentity } = await import("./repo.ts");
      const { pickWorktreeWithSwitch, pickFromAllRepos, isSwitchRepo }
        = await import("./pickers.ts");

      // includeMissing: true so pickFromAllRepos's missing guard (below, via
      // "Switch repo") actually sees a lost row instead of a silently
      // filtered list.
      const repos = getKnownRepos({ includeMissing: true });
      // KnownRepo.repoName holds the index key — a serialized identity, not
      // the display name ctx.identity.repoName carries.
      const currentRepo = repos.find(r => r.repoName === ctx.identity!.identity);

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
      clearScreen();
      if (!node.fullscreen) renderHeader([...breadcrumb, resolvedName]);
      continue;
    }
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Screen control belongs to a terminal, never a pipe. Unguarded, the
 * clear-screen sequence lands in logs and CI output and — worse — erases
 * whatever a failing command already wrote, so an error message and the
 * remedy pointing at it both survive into a log that no longer contains it.
 */
function clearScreen(): void {
  if (process.stderr.isTTY) process.stderr.write("\x1b[2J\x1b[H");
}

/**
 * Decoration, same rule. It is also the first line of stderr, so a caller
 * reading `stderr` for a failure reason gets the breadcrumb instead of the
 * error unless this stays off a pipe.
 */
function renderHeader(breadcrumb: string[]): void {
  if (!process.stderr.isTTY) return;
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

// ─── Help (--help / -h at any node) ──────────────────────────────────────────

const HELP_FLAGS = new Set(["--help", "-h"]);

/** Help is the requested product: stdout, ANSI only when stdout is a TTY. */
function helpColors(): { b: string; d: string; r: string } {
  return process.stdout.isTTY ? { b: bold, d: dim, r: reset } : { b: "", d: "", r: "" };
}

function slugArg(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, "-");
}

function argToken(a: CommandArg): string {
  if (!a.flag) return a.optional ? `[<${slugArg(a.name)}>]` : `<${slugArg(a.name)}>`;
  return a.type === "boolean" ? `[${a.flag}]` : `[${a.flag} <${slugArg(a.name)}>]`;
}

function printCommandListing(tree: Record<string, CommandNode>): void {
  const { b, d, r } = helpColors();
  const visible = Object.entries(tree).filter(([, n]) => isNodeVisible(n, IS_DEV_MODE));
  const width = Math.max(...visible.map(([name]) => name.length), 0);
  for (const [name, sub] of visible) {
    console.log(`  ${b}${name.padEnd(width + 2)}${r}${d}${sub.description}${r}`);
  }
}

function printBranchHelp(
  tree: Record<string, CommandNode>,
  breadcrumb: string[],
  root: Record<string, CommandNode>,
): void {
  const { b, d, r } = helpColors();
  const node = nodeAtPath(root, breadcrumb.slice(1));
  console.log(`\n  ${b}usage:${r} ${breadcrumb.join(" ")} <command>`);
  if (node?.description) console.log(`  ${d}${node.description}${r}`);
  console.log("");
  printCommandListing(tree);
  console.log("");
}

function printLeafHelp(node: CommandNode, breadcrumb: string[]): void {
  const { b, d, r } = helpColors();
  const args = node.args ?? [];
  const tokens = [
    ...args.filter((a) => !a.flag).map(argToken),
    ...args.filter((a) => a.flag).map(argToken),
  ];
  if (node.subcommands) tokens.push("[<command>]");

  console.log(`\n  ${b}usage:${r} ${[...breadcrumb, ...tokens].join(" ")}`);
  console.log(`  ${d}${node.description}${r}`);
  if (node.aliases?.length) console.log(`  ${d}aliases: ${node.aliases.join(", ")}${r}`);

  if (args.length) {
    console.log("");
    const rows = args.map((a) => {
      const token = a.flag
        ? (a.type === "boolean" ? a.flag : `${a.flag} <${slugArg(a.name)}>`)
        : `<${slugArg(a.name)}>`;
      let detail = a.hint ?? a.name;
      if (a.default !== undefined) detail += `  (default: ${a.default})`;
      return [token, detail] as const;
    });
    const width = Math.max(...rows.map(([t]) => t.length));
    for (const [token, detail] of rows) {
      console.log(`  ${b}${token.padEnd(width + 2)}${r}${d}${detail}${r}`);
    }
  }

  if (node.subcommands) {
    console.log("");
    printCommandListing(node.subcommands);
  }
  console.log("");
}

/** Resolve the node a breadcrumb path (minus "rt") points at, aliases included. */
function nodeAtPath(root: Record<string, CommandNode>, path: string[]): CommandNode | null {
  let tree: Record<string, CommandNode> | null = root;
  let node: CommandNode | null = null;
  for (const name of path) {
    if (!tree) return null;
    node = resolveNode(tree, name);
    if (!node) return null;
    tree = node.subcommands ?? null;
  }
  return node;
}

/** Sentinel: the user pressed ctrl-up at a subtree picker. */
export const BACK: unique symbol = Symbol("back");

interface PickerSelection {
  command: string;
  withArgs: boolean;
}

export async function showPicker(
  tree: Record<string, CommandNode>,
  breadcrumb: string[],
): Promise<PickerSelection | typeof BACK | null> {
  const { runPick } = await import("./ui/pick.ts");

  const visible = Object.entries(tree).filter(([_, n]) => isNodeVisible(n, IS_DEV_MODE));
  const anyHasArgs = visible.some(([_, n]) => n.args?.length);
  const labelWidth = Math.max(...visible.map(([name]) => name.length));

  const rows: PickRow[] = visible.map(([name, node]) => ({
    value: name,
    left: [
      { text: name.padEnd(labelWidth), bold: true },
      { text: `  ${node.description}`, tone: "dim" },
    ],
    ...(node.args?.length ? { withArgs: true } : {}),
  }));

  const actions: PickAction[] = [
    { id: "select", label: "select", key: "enter", scope: "item", group: "pick", primary: true },
  ];
  if (anyHasArgs) {
    actions.push({ id: "with-args", label: "with args", key: "alt-enter", scope: "item", group: "pick" });
  }
  // ctrl-up is always bound: at the root it has nowhere to go back to, so it
  // cancels (same as Esc) rather than going silently unbound.
  actions.push({ id: "back", label: "back", key: "ctrl-up", scope: "global" });

  const handle = runPick({
    message: breadcrumb.join(" "),
    breadcrumb,
    rows,
    actions,
  });

  const result = await handle.result;

  if (result.action === "back") return breadcrumb.length > 1 ? BACK : null;
  if (result.action === "cancel" || !result.value) return null;

  return { command: result.value, withArgs: result.action === "with-args" };
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
    const loader = MODULE_REGISTRY[node.module];
    if (loader) {
      const mod = await loader();
      const fn = mod[node.fn || "run"];
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
