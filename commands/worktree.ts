#!/usr/bin/env bun

/**
 * rt worktree — the worktree lifecycle CLI (spec §3): provision, create,
 * dispose, list, freshen, adopt, and `each` (run a command across worktrees).
 *
 * Every mutating verb here is a thin wrapper over the daemon's `worktree:*`
 * handlers (`lib/daemon/handlers/worktree.ts`) — the daemon is the single
 * writer of the registry, so there is no inline fallback when it's down
 * (`daemonQuery` returning null is a hard stop, not a "do it locally"
 * signal). The one exception is `worktreeEach`, which is read-only and falls
 * back to enumerating worktrees straight from git.
 */

import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import { RT_DIR } from "../lib/daemon-config.ts";
import { getRepoIdentity } from "../lib/repo.ts";
import { loadRepoIndex } from "../lib/repo-index.ts";
import { currentRepoIdentity, repoLabel, resolveRepoArg } from "../lib/repo-arg.ts";
import { loadWorktreeRepoConfig, inspectReadyGate } from "../lib/worktree/config.ts";
import { writeReadyApproval } from "../lib/worktree/ready-approval.ts";
import { daemonQuery, lastQueryTimedOut, type DaemonResponse } from "../lib/daemon-client.ts";
import { listWorktrees } from "../lib/git-worktrees.ts";
import {
  parseEachArgs,
  filterTargets,
  relWorktreeName,
  formatSummary,
  hasFailures,
  type EachResult,
  type WorktreeBinding,
} from "../lib/worktree-each.ts";

// Provision and create both do a targeted `git fetch` / cold clone (up to
// 5 min server-side per lib/daemon/handlers/worktree.ts) — give the round
// trip room beyond that. Dispose and freshen get their own generous budgets
// (freshen's fetch alone is budgeted 5min server-side, and a repo-wide sweep
// with no `tree` given can touch many trees in one call). The default 2s
// daemonQuery timeout used elsewhere is a client-not-a-daemon-op number —
// using it here would make the CLI report "daemon unavailable" while the
// daemon is still working.
const PROVISION_TIMEOUT_MS = 6 * 60_000;
const DISPOSE_TIMEOUT_MS = 2 * 60_000;
const FRESHEN_TIMEOUT_MS = 10 * 60_000;
const ADOPT_TIMEOUT_MS = 2 * 60_000;
// Restore recreates the worktree AND re-runs ready steps (an install), so it
// gets provision's budget rather than dispose's.
const RESTORE_TIMEOUT_MS = 6 * 60_000;

// ─── Arg parsing (pure — unit tested in lib/__tests__/worktree-cli-args.test.ts) ──

/** A value token that itself looks like a flag (starts with "-") is never a value — the flag was passed bare. */
function isFlagLike(token: string | undefined): boolean {
  return token !== undefined && token.startsWith("-");
}

function takeFlag(args: string[], flag: string): { value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1 || args[idx + 1] === undefined || isFlagLike(args[idx + 1])) {
    return { value: undefined, rest: args };
  }
  return { value: args[idx + 1], rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

function takeBoolFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  return { present: true, rest: [...args.slice(0, idx), ...args.slice(idx + 1)] };
}

export interface ProvisionArgs {
  repoName?: string;
  ticket?: string;
  title?: string;
  branch?: string;
  owner?: string;
  disposal?: string;
  wait: boolean;
  json: boolean;
}

export function parseProvisionArgs(args: string[]): ProvisionArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const wait = takeBoolFlag(rest, "--wait"); rest = wait.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  const ticket = takeFlag(rest, "--ticket"); rest = ticket.rest;
  const title = takeFlag(rest, "--title"); rest = title.rest;
  const branch = takeFlag(rest, "--branch"); rest = branch.rest;
  const owner = takeFlag(rest, "--owner"); rest = owner.rest;
  const disposal = takeFlag(rest, "--disposal"); rest = disposal.rest;
  return {
    repoName: repo.value,
    ticket: ticket.value,
    title: title.value,
    branch: branch.value,
    owner: owner.value,
    disposal: disposal.value,
    wait: wait.present,
    json: json.present,
  };
}

export interface CreateArgs {
  repoName?: string;
  onDeck: boolean;
  json: boolean;
}

export function parseCreateArgs(args: string[]): CreateArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const onDeck = takeBoolFlag(rest, "--on-deck"); rest = onDeck.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  return { repoName: repo.value, onDeck: onDeck.present, json: json.present };
}

export interface DisposeArgs {
  tree?: string;
  owner?: string;
  repoName?: string;
  force: boolean;
  json: boolean;
}

export function parseDisposeArgs(args: string[]): DisposeArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const force = takeBoolFlag(rest, "--force"); rest = force.rest;
  const owner = takeFlag(rest, "--owner"); rest = owner.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  const tree = rest.find((a) => !a.startsWith("--"));
  return { tree, owner: owner.value, repoName: repo.value, force: force.present, json: json.present };
}

export interface RestoreArgs {
  tree?: string;
  repoName?: string;
  list: boolean;
  json: boolean;
}

export function parseRestoreArgs(args: string[]): RestoreArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const list = takeBoolFlag(rest, "--list"); rest = list.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  const tree = rest.find((a) => !a.startsWith("--"));
  return { tree, repoName: repo.value, list: list.present, json: json.present };
}

export interface ListArgs {
  repoName?: string;
  json: boolean;
}

export function parseListArgs(args: string[]): ListArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  return { repoName: repo.value, json: json.present };
}

export interface FreshenArgs {
  tree?: string;
  repoName?: string;
  json: boolean;
}

export function parseFreshenArgs(args: string[]): FreshenArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  const tree = rest.find((a) => !a.startsWith("--"));
  return { tree, repoName: repo.value, json: json.present };
}

export interface AdoptArgs {
  repoName?: string;
  json: boolean;
  claim: boolean;
}

export function parseAdoptArgs(args: string[]): AdoptArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const claim = takeBoolFlag(rest, "--claim"); rest = claim.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  return { repoName: repo.value, json: json.present, claim: claim.present };
}

// ─── Shared IO helpers ───────────────────────────────────────────────────────

const DAEMON_DOWN_MESSAGE = "daemon unavailable — worktree lifecycle needs the daemon (rt daemon start)";
const DAEMON_TIMEOUT_MESSAGE = "timed out — the daemon may still be working; check rt worktree list";

/**
 * `daemonQuery` returned null: hard stop, no inline fallback (spec §3). Two
 * very different reasons collapse to null — genuinely down, or a slow
 * operation (provision's fetch, a repo-wide freshen sweep) outran its
 * timeout while the daemon kept working — so `lastQueryTimedOut()` picks the
 * message that doesn't lie about which one happened.
 */
function daemonUnavailable(): never {
  const message = lastQueryTimedOut() ? DAEMON_TIMEOUT_MESSAGE : DAEMON_DOWN_MESSAGE;
  console.log(`\n  ${red}✗${reset} ${message}\n`);
  process.exit(1);
}

function failText(json: boolean, message: string): never {
  if (json) console.log(JSON.stringify({ error: message }));
  else console.log(`\n  ${red}✗${reset} ${message}\n`);
  process.exit(1);
}

function explainError(error: string): string {
  if (error === "busy") return "that worktree is locked by another operation right now — try again shortly";
  if (error === "repo-unknown") return "unknown repo — pass --repo <name> or run from inside a registered repo";
  if (error === "branch-unresolved") return "need --branch <name> or --ticket <id> to name the work branch";
  if (error === "no-target") return "need a tree name or --owner to know what to dispose";
  if (error === "tree-ambiguous") return "that tree name matches worktrees in more than one repo — pass --repo to disambiguate";
  if (error === "branch-duplicated") return "that branch is already checked out in more than one worktree — run `rt worktree adopt`";
  if (error.startsWith("branch-attached:")) {
    return `branch is already checked out in worktree "${error.slice("branch-attached:".length)}"`;
  }
  if (error.startsWith("checkout-failed:")) return `checkout failed: ${error.slice("checkout-failed:".length)}`;
  if (error.startsWith("create-failed:")) return `worktree creation failed at step "${error.slice("create-failed:".length)}"`;
  if (error === "not-found") return "no retained trash entry with that name";
  if (error === "no-manifest") return "that entry has no disposal manifest (disposed before RT-51, or the write failed) and cannot be restored";
  if (error === "branch-elsewhere") return "that branch already exists again... restore refuses to clobber it";
  if (error === "no-head-sha") return "the disposal manifest has no recorded commit to restore from";
  if (error === "path-exists") return "the pool root already has a tree at that name";
  if (error === "worktree-add-failed") return "git worktree add failed while restoring";
  if (error === "copy-failed") {
    return "the worktree was recreated but copying the retained tree's gitignored content back failed... " +
      "the checkout and the retained trash entry are both left in place; a plain retry will refuse " +
      "with \"path-exists\", so recover by hand (copy the entry's content over yourself, or `rt worktree dispose --force` the half-restored tree and retry)";
  }
  if (error === "register-failed") {
    return "the worktree was recreated but the registry write did not land, so rt does not know about it yet... " +
      "the checkout and the retained trash entry are both left in place; a plain retry will refuse " +
      "with \"branch-elsewhere\"/\"path-exists\", so recover by hand (`rt worktree adopt --repo <name>` picks up the checkout, or dispose it and retry)";
  }
  return error;
}

function failResult(json: boolean, error: string): never {
  if (json) console.log(JSON.stringify({ error }));
  else console.log(`\n  ${red}✗${reset} ${explainError(error)}\n`);
  process.exit(1);
}

function requireQueryResult(json: boolean, res: DaemonResponse | null): DaemonResponse {
  if (res === null) daemonUnavailable();
  if (!res.ok) failResult(json, res.error ?? "unknown error");
  return res;
}

/** Re-exported so existing imports of `repoLabel` from this module keep compiling — the implementation now lives in `lib/repo-arg.ts` alongside `resolveRepoArg`, which it shares a parity contract with. */
export { repoLabel } from "../lib/repo-arg.ts";

// ─── Tree rows (worktree:list) shared by list / nav / the dispose+freshen pickers ──

interface TreeRow {
  name: string;
  path: string;
  kind: string;
  state?: string;
  branch: string | null;
  owner?: string;
  disposableReason?: string;
  repoName: string;
  mr?: { iid: number; state: string; title: string } | null;
  duplicateBranch?: boolean;
}

async function fetchTreeRows(json: boolean, repoName?: string): Promise<TreeRow[]> {
  const res = await daemonQuery("worktree:list", repoName ? { repoName } : undefined);
  const ok = requireQueryResult(json, res);
  return (ok.data?.trees ?? []) as TreeRow[];
}

/**
 * MR/pipeline/ticket metadata for each tree, reusing the same `enrich`
 * pipeline `rt cd` renders — one daemon `cache:read` per repo, same source as
 * `worktree:list`. Returns the `enrich` trailing (`✓ ● TICKET`) keyed by path.
 *
 * The linearId is appended when `enrich` would otherwise omit it: for a ticket
 * branch it parks the ticket title in the label's leading half, which these
 * pickers don't render (their label is the tree name), so the id must ride in
 * the trailing to stay visible.
 */
async function enrichTrailingByPath(rows: TreeRow[]): Promise<Map<string, string>> {
  const byPath = new Map<string, string>();
  const withBranch = rows.filter((r): r is TreeRow & { branch: string } => Boolean(r.branch));
  if (withBranch.length === 0) return byPath;

  const { enrichBranches, formatBranchLabelParts } = await import("../lib/enrich.ts");
  const { getRemoteUrl } = await import("../lib/pickers.ts");
  const repoIndex = loadRepoIndex();

  const byRepo = new Map<string, Array<TreeRow & { branch: string }>>();
  for (const r of withBranch) {
    const group = byRepo.get(r.repoName) ?? [];
    group.push(r);
    byRepo.set(r.repoName, group);
  }

  await Promise.all(
    [...byRepo].map(async ([repoName, group]) => {
      const repoPath = repoIndex[repoName];
      const remoteUrl = repoPath ? await getRemoteUrl(repoPath) : undefined;
      const enriched = await enrichBranches(
        group.map((r) => ({ path: r.path, branch: r.branch })),
        remoteUrl,
      );
      for (const eb of enriched) {
        let trailing = formatBranchLabelParts(eb).trailing;
        if (eb.linearId && !trailing.includes(eb.linearId)) {
          trailing = trailing ? `${trailing} ${eb.linearId}` : eb.linearId;
        }
        if (trailing) byPath.set(eb.path, trailing);
      }
    }),
  );
  return byPath;
}

async function pickOneTree(rows: TreeRow[], message: string): Promise<TreeRow | null> {
  if (rows.length === 0) return null;
  const { filterableSelect } = await import("../lib/rt-render.ts");
  const trailingByPath = await enrichTrailingByPath(rows);
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const options = rows.map((r) => {
    const state = r.state ?? r.kind;
    const base =
      state === "disposable"
        ? r.disposableReason
          ? `disposable — ${r.disposableReason}`
          : "disposable"
        : `${state}${r.branch ? `  ${r.branch}` : ""}${r.owner ? `  ${r.owner}` : ""}`;
    const trailing = trailingByPath.get(r.path);
    const hint = trailing ? `${base}  ${trailing}` : base;
    return { value: r.path, label: r.name.padEnd(nameWidth), hint };
  });
  const picked = await filterableSelect({ message, options, stderr: true });
  if (!picked) return null;
  return rows.find((r) => r.path === picked) ?? null;
}

/** Disposable first (with their reason as the hint), then everything else. */
function sortDisposableFirst(rows: TreeRow[]): TreeRow[] {
  const rank = (r: TreeRow) => (r.state === "disposable" ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ─── provision ───────────────────────────────────────────────────────────────

export async function worktreeProvision(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseProvisionArgs(args);
  const repoName = parsed.repoName ? await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m)) : currentRepoIdentity();
  if (!repoName) failText(parsed.json, "no repo — pass --repo <name> or run from inside a registered repo");

  const payload: Record<string, unknown> = { repoName };
  if (parsed.owner) payload.owner = parsed.owner;
  if (parsed.disposal) payload.disposal = parsed.disposal;
  if (parsed.wait) payload.wait = true;
  if (parsed.branch) {
    payload.branch = parsed.branch;
  } else if (parsed.ticket) {
    payload.ticket = parsed.ticket;
    if (parsed.title) payload.ticketTitle = parsed.title;
  }

  const res = await daemonQuery("worktree:provision", payload, PROVISION_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  const d = ok.data;
  console.log("");
  console.log(`  ${green}✓${reset} ${bold}${d.tree}${reset}  ${dim}${d.path}${reset}`);
  console.log(`  branch ${cyan}${d.branch}${reset} ${dim}(${d.branchState}${d.wasOnDeck ? ", from the on-deck pool" : ""})${reset}`);
  if (d.readyHeld) {
    console.log(`  ${yellow}⚠${reset} team ready steps held pending approval — run ${cyan}rt worktree ready-approve${reset}`);
  }
  if (d.readyPending) {
    console.log(`  ${dim}⧗ settling in background: ${(d.readySteps ?? []).join(", ")}${reset}`);
    console.log(`  ${dim}  rt worktree await-ready ${d.tree} — wait for it before running anything that needs deps${reset}`);
  }
  if (d.readyFailed) {
    console.log(`  ${yellow}⚠${reset} ready step "${d.failedStep}" failed — tree is usable but dependencies may be stale`);
  }
  console.log("");
}

// ─── await-ready ─────────────────────────────────────────────────────────────

/** Settles can legitimately run for minutes (installs, migrations); give the
 *  join more headroom than the steps' own timeouts before daemonUnavailable. */
const AWAIT_READY_TIMEOUT_MS = 10 * 60_000;

export interface AwaitReadyArgs {
  tree?: string;
  repoName?: string;
  json: boolean;
}

export function parseAwaitReadyArgs(args: string[]): AwaitReadyArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  return { tree: rest[0], repoName: repo.value, json: json.present };
}

export async function worktreeAwaitReady(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseAwaitReadyArgs(args);
  let treeName = parsed.tree;
  let repoName = parsed.repoName ? await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m)) : undefined;

  if (!treeName) {
    if (!process.stdin.isTTY || parsed.json || process.env.RT_BATCH) {
      failText(parsed.json, "no tree — pass a tree name (no TTY for the picker)");
    }
    // Only claimed trees carry a claim-time settle to wait on.
    const rows = (await fetchTreeRows(parsed.json, repoName)).filter((r) => r.state === "claimed");
    const picked = await pickOneTree(rows, "Await which worktree's readiness?");
    if (!picked) { console.log(`\n  ${dim}nothing selected${reset}\n`); return; }
    treeName = picked.name;
    repoName = picked.repoName;
  }
  if (!repoName) {
    repoName = currentRepoIdentity() ?? undefined;
    if (!repoName) failText(parsed.json, "no repo — pass --repo <name> or run from inside a registered repo");
  }

  const res = await daemonQuery("worktree:await-ready", { repoName, tree: treeName }, AWAIT_READY_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  const d = ok.data;
  console.log("");
  if (d.ready) {
    console.log(`  ${green}✓${reset} ${bold}${d.tree}${reset} ready ${dim}(${d.readyAt ?? "no steps to run"})${reset}`);
  } else {
    process.exitCode = 1;
    console.log(`  ${yellow}⚠${reset} ${bold}${d.tree}${reset} settled degraded — step "${d.failedStep}" failed; tree is usable but dependencies may be stale`);
  }
  console.log("");
}

// ─── create ──────────────────────────────────────────────────────────────────

export async function worktreeCreate(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseCreateArgs(args);
  const repoName = parsed.repoName ? await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m)) : currentRepoIdentity();
  if (!repoName) failText(parsed.json, "no repo — pass --repo <name> or run from inside a registered repo");

  const res = await daemonQuery("worktree:create", { repoName, onDeck: parsed.onDeck }, PROVISION_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  console.log("");
  console.log(`  ${green}✓${reset} ${bold}${ok.data.tree}${reset}  ${dim}${ok.data.path}${reset}${parsed.onDeck ? `  ${dim}(on-deck)${reset}` : ""}`);
  console.log("");
}

// ─── dispose ─────────────────────────────────────────────────────────────────

export async function worktreeDispose(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseDisposeArgs(args);
  let treeName = parsed.tree;
  let repoName = parsed.repoName ? await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m)) : undefined;

  if (!treeName && !parsed.owner) {
    if (!process.stdin.isTTY) {
      failText(parsed.json, "no target — pass a tree name or --owner (no TTY for the picker)");
    }
    // Only rt-managed (ephemeral) trees are ever disposable — offering the
    // main clone here would just earn every pick a pointless "kind-main" refusal.
    const rows = sortDisposableFirst(
      (await fetchTreeRows(parsed.json, repoName)).filter((r) => r.kind === "ephemeral"),
    );
    const picked = await pickOneTree(rows, "Dispose which worktree?");
    if (!picked) { console.log(`\n  ${dim}nothing selected${reset}\n`); return; }
    treeName = picked.name;
    repoName = picked.repoName;
  }

  const payload: Record<string, unknown> = { force: parsed.force, callerPid: process.pid };
  if (repoName) payload.repoName = repoName;
  if (parsed.owner) payload.owner = parsed.owner;
  if (treeName) payload.tree = treeName;

  const res = await daemonQuery("worktree:dispose", payload, DISPOSE_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  const { disposed, refused, recoverable } = ok.data as {
    disposed: string[];
    refused: Array<{ tree: string; reason: string }>;
    recoverable?: Array<{ tree: string; path: string; until: string }>;
  };
  // Set before either return path — --json must not exit 0 on a partial failure.
  if (refused.length > 0) process.exitCode = 1;

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  console.log("");
  for (const name of disposed) {
    const kept = recoverable?.find((r) => r.tree === name);
    const note = kept ? ` ${dim}— recoverable at ${kept.path} until ${kept.until.slice(0, 10)}${reset}` : "";
    console.log(`  ${green}✓${reset} ${name} disposed${note}`);
  }
  for (const r of refused) {
    const hint = r.reason === "remove-failed" ? " — transient, try again" : "";
    console.log(`  ${red}✗${reset} ${r.tree} ${dim}(${r.reason}${hint})${reset}`);
  }
  if (disposed.length === 0 && refused.length === 0) console.log(`  ${dim}nothing to dispose${reset}`);
  console.log("");
}

// ─── restore ─────────────────────────────────────────────────────────────────

/** Restorable trash entries for `repoName`, straight from disk (read-only, so like `each` this skips the daemon round trip). */
async function fetchRestorableEntries(repoName: string, repoPath: string) {
  const { listRestorableEntries } = await import("../lib/worktree/restore.ts");
  return listRestorableEntries(repoName, repoPath);
}

function printRestorableEntries(entries: Awaited<ReturnType<typeof fetchRestorableEntries>>): void {
  if (entries.length === 0) { console.log(`\n  ${dim}nothing recoverable${reset}\n`); return; }
  console.log("");
  for (const e of entries) {
    console.log(
      `  ${bold}${e.name}${reset}  ${cyan}${e.branch ?? "(detached)"}${reset}  ${dim}disposed ${e.disposedAt.slice(0, 10)} (${e.reason}), kept until ${e.keptUntil.slice(0, 10)}${reset}`,
    );
  }
  console.log("");
}

async function pickRestorableEntry(entries: Awaited<ReturnType<typeof fetchRestorableEntries>>): Promise<string | null> {
  if (entries.length === 0) return null;
  const { filterableSelect } = await import("../lib/rt-render.ts");
  const nameWidth = Math.max(...entries.map((e) => e.name.length));
  const options = entries.map((e) => ({
    value: e.name,
    label: e.name.padEnd(nameWidth),
    hint: `${e.branch ?? "(detached)"}  disposed ${e.disposedAt.slice(0, 10)} (${e.reason}), kept until ${e.keptUntil.slice(0, 10)}`,
  }));
  return filterableSelect({ message: "Restore which worktree?", options, stderr: true });
}

export async function worktreeRestore(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseRestoreArgs(args);
  const repoName = parsed.repoName ? await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m)) : currentRepoIdentity();
  if (!repoName) failText(parsed.json, "no repo... pass --repo <name> or run from inside a registered repo");

  const repoIndex = loadRepoIndex();
  const repoPath = repoIndex[repoName];
  if (!repoPath) failText(parsed.json, `repo "${repoName}" not registered in ~/.mattstack/rt/repos.json`);

  if (parsed.list) {
    const entries = await fetchRestorableEntries(repoName, repoPath);
    if (parsed.json) { console.log(JSON.stringify({ entries }, null, 2)); return; }
    printRestorableEntries(entries);
    return;
  }

  let treeName = parsed.tree;
  if (!treeName) {
    if (process.stdin.isTTY && !parsed.json && !process.env.RT_BATCH) {
      const entries = await fetchRestorableEntries(repoName, repoPath);
      const picked = await pickRestorableEntry(entries);
      if (!picked) { console.log(`\n  ${dim}nothing selected${reset}\n`); return; }
      treeName = picked;
    } else {
      failText(parsed.json, "no target... pass a tree name (no TTY for the picker)");
    }
  }

  const res = await daemonQuery("worktree:restore", { repoName, tree: treeName }, RESTORE_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  const d = ok.data as { restored: boolean; path: string; tree: string; readyFailed?: boolean; failedStep?: string };
  console.log("");
  console.log(`  ${green}✓${reset} ${bold}${d.tree}${reset} restored  ${dim}${d.path}${reset}`);
  if (d.readyFailed) {
    console.log(`  ${yellow}⚠${reset} ready step "${d.failedStep}" failed... tree is usable but dependencies may be stale`);
  }
  console.log("");
}

// ─── list ────────────────────────────────────────────────────────────────────

export async function worktreeList(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseListArgs(args);
  const repoName = parsed.repoName ? await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m)) : undefined;
  const res = await daemonQuery("worktree:list", repoName ? { repoName } : undefined);
  const ok = requireQueryResult(parsed.json, res);
  const rows = (ok.data?.trees ?? []) as TreeRow[];
  const readyHeldRepos = (ok.data?.readyHeldRepos ?? []) as string[];

  if (parsed.json) { console.log(JSON.stringify({ trees: rows, readyHeldRepos }, null, 2)); return; }

  if (rows.length === 0) {
    if (readyHeldRepos.length > 0) {
      console.log(`\n  ${yellow}team \`ready\` steps held pending approval${reset}  ${dim}${readyHeldRepos.map(repoLabel).join(", ")} ... run \`rt worktree ready-approve <repo>\`${reset}`);
    }
    console.log(`\n  ${dim}no worktrees${reset}\n`);
    return;
  }

  const trailingByPath = await enrichTrailingByPath(rows);
  console.log("");
  if (readyHeldRepos.length > 0) {
    console.log(`  ${yellow}team \`ready\` steps held pending approval${reset}  ${dim}${readyHeldRepos.map(repoLabel).join(", ")} ... run \`rt worktree ready-approve <repo>\`${reset}`);
  }
  for (const r of rows) {
    const trailing = trailingByPath.get(r.path);
    const mrPart = trailing
      ? `  ${trailing}`
      : r.mr
        ? `  ${dim}!${r.mr.iid} ${r.mr.state}${reset}`
        : "";
    const dupPart = r.duplicateBranch ? `  ${yellow}duplicate branch${reset}` : "";
    const ownerPart = r.owner ? `  ${dim}${r.owner}${reset}` : "";
    console.log(
      `  ${bold}${repoLabel(r.repoName)}/${r.name}${reset}  ${dim}${r.state ?? r.kind}${reset}  ${cyan}${r.branch ?? "(detached)"}${reset}${ownerPart}${mrPart}${dupPart}`,
    );
  }
  console.log("");
}

// ─── ready-approve ────────────────────────────────────────────────────────────

async function pickRepoName(repoIndex: Record<string, string>): Promise<string | undefined> {
  const names = Object.keys(repoIndex);
  if (names.length === 0) return undefined;
  const { filterableSelect } = await import("../lib/rt-render.ts");
  const picked = await filterableSelect({
    message: "Approve team ready steps for which repo?",
    options: names.map((n) => ({ value: n, label: repoLabel(n) })),
    stderr: true,
  });
  return picked ?? undefined;
}

async function confirmApprove(): Promise<boolean> {
  const { filterableSelect } = await import("../lib/rt-render.ts");
  const picked = await filterableSelect({
    message: "Approve these steps to run unattended on every create/freshen?",
    options: [
      { value: "approve", label: "Approve" },
      { value: "cancel", label: "Cancel" },
    ],
    stderr: true,
  });
  return picked === "approve";
}

/**
 * Approve a repo's team-authored `ready` shell before it runs (RT-89). The
 * daemon fail-closes on an unapproved team ladder; this records the user's
 * approval, keyed by the ladder's content hash so a later team edit re-holds it.
 * TTY only: a non-interactive caller gets the hash and a nonzero exit, never a
 * prompt.
 */
export async function worktreeReadyApprove(args: string[], _ctx: unknown): Promise<void> {
  const json = args.includes("--json");
  const interactive = !!process.stdin.isTTY && !json && !process.env.RT_BATCH;
  const positional = args.filter((a) => !a.startsWith("-"));

  const repoIndex = loadRepoIndex();
  let repoName = positional[0]
    ? await resolveRepoArg(positional[0], (m) => failText(json, m))
    : undefined;
  if (!repoName) {
    if (!interactive) failText(json, "no repo... pass a repo name (no TTY for the picker)");
    repoName = await pickRepoName(repoIndex);
    if (!repoName) { console.log(`\n  ${dim}nothing selected${reset}\n`); return; }
  }

  const repoPath = repoIndex[repoName];
  if (!repoPath) failText(json, `repo not registered: ${repoName}`);

  const cfg = await loadWorktreeRepoConfig(repoName, repoPath);
  const info = await inspectReadyGate(cfg, repoPath);

  if (!info.teamOwned) {
    if (json) { console.log(JSON.stringify({ teamOwned: false })); return; }
    console.log(`\n  ${dim}no team-authored ready steps to approve for ${repoLabel(repoName)}${reset}\n`);
    return;
  }
  if (info.approved) {
    if (json) { console.log(JSON.stringify({ teamOwned: true, approved: true, hash: info.hash })); return; }
    console.log(`\n  ${green}already approved${reset}  ${dim}${info.hash}${reset}\n`);
    return;
  }
  if (!info.identity) failText(json, "repo has no derivable identity; cannot record an approval");

  if (!interactive) {
    // Never prompt off a TTY: name the hash and exit nonzero so a script must
    // approve deliberately (mirrors the leaf-picker gate).
    failText(
      json,
      `team \`ready\` steps for ${repoLabel(repoName)} need approval (hash ${info.hash}). Re-run in a TTY, or: rt settings set rt.worktreeReadyApproval '${info.hash}' --scope user`,
    );
  }

  console.log(`\n  ${yellow}team-authored ready steps${reset} for ${bold}${repoLabel(repoName)}${reset}  ${dim}(hash ${info.hash})${reset}\n`);
  for (const s of info.ladder) {
    console.log(`    ${s.run}${s.when ? `  ${dim}(${s.when})${reset}` : ""}`);
  }
  console.log("");

  if (!(await confirmApprove())) { console.log(`  ${dim}not approved${reset}\n`); return; }
  writeReadyApproval(info.identity, info.hash);
  console.log(`  ${green}approved${reset}  ${dim}${info.hash}${reset}\n`);
}

// ─── freshen ─────────────────────────────────────────────────────────────────

export async function worktreeFreshen(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseFreshenArgs(args);
  let treeName = parsed.tree;
  let repoName = parsed.repoName ? await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m)) : undefined;

  if (!treeName && process.stdin.isTTY) {
    // Mirrors freshenCandidate (lib/daemon/worktree-reconciler.ts): only
    // on-deck ephemeral trees and the main clone are ever freshened — a
    // claimed tree is someone's active work and always comes back ran:[].
    const rows = (await fetchTreeRows(parsed.json, repoName))
      .filter((r) => (r.kind === "ephemeral" && r.state === "on-deck") || r.kind === "main")
      .sort((a, b) => a.name.localeCompare(b.name));
    const picked = await pickOneTree(rows, "Freshen which worktree?");
    if (!picked) { console.log(`\n  ${dim}nothing selected${reset}\n`); return; }
    treeName = picked.name;
    repoName = picked.repoName;
  }

  const payload: Record<string, unknown> = {};
  if (repoName) payload.repoName = repoName;
  if (treeName) payload.tree = treeName;

  const res = await daemonQuery("worktree:freshen", payload, FRESHEN_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  const ran = (ok.data?.ran ?? []) as string[];
  console.log("");
  if (ran.length === 0) console.log(`  ${dim}nothing needed freshening${reset}`);
  else for (const name of ran) console.log(`  ${green}✓${reset} ${name} freshened`);
  console.log("");
}

// ─── adopt ───────────────────────────────────────────────────────────────────

export async function worktreeAdopt(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseAdoptArgs(args);
  // Deliberately no cwd fallback: adopt rewrites the whole repo's registry in
  // one sweep, so it must be pointed at explicitly rather than guessed from
  // wherever the shell happens to be.
  if (!parsed.repoName) failText(parsed.json, "--repo <name> is required for adopt");
  const repoName = await resolveRepoArg(parsed.repoName, (m) => failText(parsed.json, m));

  const res = await daemonQuery("worktree:adopt", { repoName, claim: parsed.claim }, ADOPT_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  const d = ok.data as {
    main: string;
    claimed: string[];
    unmanaged: string[];
    disposed: string[];
    refused: Array<{ tree: string; reason: string }>;
  };
  console.log("");
  console.log(
    `  ${green}✓${reset} adopted ${d.main ? `main=${d.main}, ` : ""}${d.claimed.length} claimed, ` +
      `${d.unmanaged.length} unmanaged, ${d.disposed.length} disposed`,
  );
  for (const name of d.claimed) console.log(`  ${green}✓${reset} ${name} ${dim}(kind: ephemeral, claimed)${reset}`);
  for (const name of d.unmanaged) console.log(`  ${dim}·${reset} ${name} ${dim}(kind: unmanaged, untouched)${reset}`);
  for (const r of d.refused) console.log(`  ${yellow}⚠${reset} ${r.tree} not disposed: ${r.reason}`);
  console.log("");
}

// ─── each ────────────────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.log(`  ${red}✗${reset} ${msg}\n`);
  process.exit(1);
}

function loadRepos(): Record<string, string> {
  return loadRepoIndex();
}

/** Bindings from the daemon's registry-aware worktree:list, when it's up. */
async function bindingsFromDaemon(repoName: string): Promise<WorktreeBinding[] | null> {
  const res = await daemonQuery("worktree:list", { repoName });
  if (res === null || !res.ok) return null;
  const rows = (res.data?.trees ?? []) as TreeRow[];
  return rows.map((r) => ({ path: r.path, branch: r.branch, state: r.state }));
}

/** Read-only git fallback — each is the one lifecycle command allowed this, since it never mutates. */
function bindingsFromGit(repoPath: string): WorktreeBinding[] {
  return listWorktrees(repoPath).map((w) => ({ path: w.path, branch: w.branch || null }));
}

export async function worktreeEach(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseEachArgs(args);
  if (parsed.error) fail(parsed.error);

  const identity = getRepoIdentity();
  if (!identity) fail("not in a git repo");

  const repos    = loadRepos();
  const repoPath = repos[identity.identity];
  if (!repoPath) fail(`repo "${identity.repoName}" not registered in ~/.mattstack/rt/repos.json`);

  const bindings = (await bindingsFromDaemon(identity.identity)) ?? bindingsFromGit(repoPath);
  if (bindings.length === 0) {
    console.log(`\n  ${dim}no worktrees in ${identity.repoName}${reset}\n`);
    return;
  }

  let targets: WorktreeBinding[];
  if (parsed.mode === "pick") {
    if (!process.stdin.isTTY) {
      fail("no --all/--on-deck flag and no TTY for the picker — pass --all or --on-deck");
    }
    const widest  = Math.max(...bindings.map(b => relWorktreeName(repoPath, b.path).length));
    const options = bindings.map(b => ({
      value: b.path,
      label: relWorktreeName(repoPath, b.path).padEnd(widest),
      hint:  b.branch ?? "(detached)",
    }));
    const { filterableMultiselect } = await import("../lib/rt-render.ts");
    const selected = await filterableMultiselect({
      message: `Run "${parsed.command}" in which worktrees? (${identity.repoName})`,
      options,
    });
    if (!selected || selected.length === 0) {
      console.log(`\n  ${dim}nothing selected${reset}\n`);
      return;
    }
    const set = new Set(selected);
    targets = bindings.filter(b => set.has(b.path));
  } else {
    targets = filterTargets(bindings, parsed.mode);
    if (targets.length === 0) {
      const what = parsed.mode === "on-deck" ? "on-deck worktrees" : "worktrees";
      console.log(`\n  ${dim}no ${what} to run in${reset}\n`);
      return;
    }
  }

  console.log("");
  const results: EachResult[] = [];
  for (const b of targets) {
    const name   = relWorktreeName(repoPath, b.path);
    const branch = b.branch ?? "(detached)";
    console.log(`${bold}── ${name}${reset} ${dim}[${branch}]${reset} ${bold}──${reset}`);

    if (!existsSync(b.path)) {
      console.log(`  ${red}✗${reset} ${dim}path no longer exists${reset}\n`);
      results.push({ name, code: 1, reason: "path gone" });
      continue;
    }

    const res = spawnSync("sh", ["-c", parsed.command], { cwd: b.path, stdio: "inherit" });
    const code = res.status ?? 1;
    console.log(code === 0
      ? `  ${green}✓${reset} ${dim}exit 0${reset}\n`
      : `  ${red}✗${reset} ${dim}exit ${code}${reset}\n`);
    results.push({ name, code });
  }

  const summary = formatSummary(results);
  console.log(`  ${hasFailures(results) ? red : green}${summary}${reset}\n`);
  if (hasFailures(results)) process.exit(1);
}
