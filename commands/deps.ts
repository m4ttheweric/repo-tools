/**
 * rt deps — resolve bundled tools by absolute path and expose them on PATH.
 *
 *   rt deps resolve <tool> [--json]
 *   rt deps link <tool> [--force] [--json]
 *   rt deps unlink <tool> [--json]
 *   rt deps reconcile [--json]
 *
 * All four are thin CLI shells over lib/deps/resolve.ts and lib/deps/links.ts
 * — this module only parses args, wires the real Probes seam, and renders.
 */

import { join } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import { DEFAULT_EXPOSED, isOurLink, link, reconcile, unlink } from "../lib/deps/links.ts";
import { resolveTool } from "../lib/deps/resolve.ts";

function tool(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

function fail(msg: string): never {
  console.error(`rt deps: ${msg}`);
  process.exit(1);
}

async function pickTool(message: string, tools: readonly string[]): Promise<string | null> {
  const { filterableSelect } = await import("../lib/rt-render.ts");
  return filterableSelect({ message, options: tools.map((name) => ({ value: name, label: name })), stderr: true });
}

/** The positional, or an interactive pick when it's omitted on a TTY; the existing `fail` in every other case (no TTY, --json, RT_BATCH). */
async function requireTool(args: string[], usage: string, message: string, candidates: () => readonly string[]): Promise<string> {
  const t = tool(args);
  if (t) return t;
  if (process.stdin.isTTY && !args.includes("--json") && !process.env.RT_BATCH) {
    const picked = await pickTool(message, candidates());
    if (!picked) process.exit(0);
    return picked;
  }
  fail(usage);
}

/** Tools currently exposed by one of our tagged links, else the known-tool set (never empty, so the picker always has candidates). */
function linkedTools(p: Probes): readonly string[] {
  const linked = p.readDir(join(p.home, ".local", "bin")).filter((name) => isOurLink(p, name));
  return linked.length ? linked : DEFAULT_EXPOSED;
}

export async function depsResolve(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const t = await requireTool(args, "usage: rt deps resolve <tool> [--json]", "Resolve which tool?", () => DEFAULT_EXPOSED);

  const resolution = resolveTool(p, t);

  if (args.includes("--json")) {
    console.log(JSON.stringify(envelope(resolution)));
    return;
  }

  console.log(`${t}:`);
  console.log(`  bundled: ${resolution.bundled ?? "(not bundled)"}`);
  console.log(`  user copy: ${resolution.userCopy ?? "(none on PATH)"}`);
  console.log(`  linked: ${resolution.linked}`);
  console.log(`  chosen: ${resolution.chosen ?? "(unresolved)"}`);
}

export async function depsLink(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const t = await requireTool(args, "usage: rt deps link <tool> [--force] [--json]", "Link which tool?", () => DEFAULT_EXPOSED);

  const outcome = link(p, t, { force: args.includes("--force") });
  const json = args.includes("--json");

  // A refusal here is user-actionable (a foreign copy on PATH, dev mode
  // owning ~/.local/bin/rt, no bundled tool) — exit 2 with the contract's
  // `{error}` envelope, the same shape `rt tools install` already uses, so
  // an app decoding row-action failures only ever needs the one path.
  if (!outcome.ok) return exitUserError(new UserActionableError(outcome.reason, outcome.detail), json, "deps link", console.log);

  if (json) {
    console.log(JSON.stringify(envelope(outcome)));
    return;
  }
  console.log(outcome.state === "already" ? `rt deps: ${t} already linked at ${outcome.path}` : `rt deps: linked ${t} at ${outcome.path}`);
}

export async function depsUnlink(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const t = await requireTool(args, "usage: rt deps unlink <tool> [--json]", "Unlink which tool?", () => linkedTools(p));

  const outcome = unlink(p, t);

  if (args.includes("--json")) {
    console.log(JSON.stringify(envelope(outcome)));
    return;
  }

  console.log(outcome.removed ? `rt deps: unlinked ${t}` : `rt deps: ${t} was not one of ours — left untouched`);
}

export async function depsReconcile(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const outcome = reconcile(p);

  if (args.includes("--json")) {
    console.log(JSON.stringify(envelope(outcome)));
    return;
  }

  if (outcome.removed.length === 0) {
    console.log("rt deps: nothing to reconcile");
    return;
  }
  console.log(`rt deps: auto-unlinked (user copy now on PATH): ${outcome.removed.join(", ")}`);
}
