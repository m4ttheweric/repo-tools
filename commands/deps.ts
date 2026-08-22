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

import type { CommandContext } from "../lib/command-tree.ts";
import { envelope } from "../lib/setup/contract.ts";
import { createRealProbes, type Probes } from "../lib/setup/probes.ts";
import { link, reconcile, unlink } from "../lib/deps/links.ts";
import { resolveTool } from "../lib/deps/resolve.ts";

function tool(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"));
}

function fail(msg: string): never {
  console.error(`rt deps: ${msg}`);
  process.exit(1);
}

export async function depsResolve(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const t = tool(args);
  if (!t) fail("usage: rt deps resolve <tool> [--json]");

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
  const t = tool(args);
  if (!t) fail("usage: rt deps link <tool> [--force] [--json]");

  const outcome = link(p, t, { force: args.includes("--force") });

  if (args.includes("--json")) {
    // Exit status carries the outcome in both modes: --json prints the
    // envelope either way, but a script parsing it should not have to also
    // inspect body.ok to notice the verb refused.
    console.log(JSON.stringify(envelope(outcome)));
    if (!outcome.ok) process.exit(1);
    return;
  }

  if (!outcome.ok) fail(outcome.detail);
  console.log(outcome.state === "already" ? `rt deps: ${t} already linked at ${outcome.path}` : `rt deps: linked ${t} at ${outcome.path}`);
}

export async function depsUnlink(args: string[], _ctx: CommandContext = {}, p: Probes = createRealProbes()): Promise<void> {
  const t = tool(args);
  if (!t) fail("usage: rt deps unlink <tool> [--json]");

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
