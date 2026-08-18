#!/usr/bin/env bun

/**
 * rt worktree — the worktree lifecycle CLI (spec §3): provision, create,
 * dispose, list, freshen, adopt, plus the bare `rt worktree` nav picker and
 * `each` (run a command across worktrees).
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
  json: boolean;
}

export function parseProvisionArgs(args: string[]): ProvisionArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
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
}

export function parseAdoptArgs(args: string[]): AdoptArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  return { repoName: repo.value, json: json.present };
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

function currentRepoName(): string | undefined {
  return getRepoIdentity()?.repoName ?? undefined;
}

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

async function pickOneTree(rows: TreeRow[], message: string): Promise<TreeRow | null> {
  if (rows.length === 0) return null;
  const { filterableSelect } = await import("../lib/rt-render.tsx");
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const options = rows.map((r) => {
    const state = r.state ?? r.kind;
    const hint =
      state === "disposable"
        ? r.disposableReason
          ? `disposable — ${r.disposableReason}`
          : "disposable"
        : `${state}${r.branch ? `  ${r.branch}` : ""}${r.owner ? `  ${r.owner}` : ""}`;
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
  const repoName = parsed.repoName ?? currentRepoName();
  if (!repoName) failText(parsed.json, "no repo — pass --repo <name> or run from inside a registered repo");

  const payload: Record<string, unknown> = { repoName };
  if (parsed.owner) payload.owner = parsed.owner;
  if (parsed.disposal) payload.disposal = parsed.disposal;
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
  if (d.readyFailed) {
    console.log(`  ${yellow}⚠${reset} ready step "${d.failedStep}" failed — tree is usable but dependencies may be stale`);
  }
  console.log("");
}

// ─── create ──────────────────────────────────────────────────────────────────

export async function worktreeCreate(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseCreateArgs(args);
  const repoName = parsed.repoName ?? currentRepoName();
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
  let repoName = parsed.repoName;

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

  const payload: Record<string, unknown> = { force: parsed.force };
  if (repoName) payload.repoName = repoName;
  if (parsed.owner) payload.owner = parsed.owner;
  if (treeName) payload.tree = treeName;

  const res = await daemonQuery("worktree:dispose", payload, DISPOSE_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  const { disposed, refused } = ok.data as { disposed: string[]; refused: Array<{ tree: string; reason: string }> };
  // Set before either return path — --json must not exit 0 on a partial failure.
  if (refused.length > 0) process.exitCode = 1;

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  console.log("");
  for (const name of disposed) console.log(`  ${green}✓${reset} ${name} disposed`);
  for (const r of refused) {
    const hint = r.reason === "remove-failed" ? " — transient, try again" : "";
    console.log(`  ${red}✗${reset} ${r.tree} ${dim}(${r.reason}${hint})${reset}`);
  }
  if (disposed.length === 0 && refused.length === 0) console.log(`  ${dim}nothing to dispose${reset}`);
  console.log("");
}

// ─── list ────────────────────────────────────────────────────────────────────

export async function worktreeList(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseListArgs(args);
  const rows = await fetchTreeRows(parsed.json, parsed.repoName);

  if (parsed.json) { console.log(JSON.stringify({ trees: rows }, null, 2)); return; }

  if (rows.length === 0) { console.log(`\n  ${dim}no worktrees${reset}\n`); return; }

  console.log("");
  for (const r of rows) {
    const mrPart = r.mr ? `  ${dim}!${r.mr.iid} ${r.mr.state}${reset}` : "";
    const dupPart = r.duplicateBranch ? `  ${yellow}duplicate branch${reset}` : "";
    const ownerPart = r.owner ? `  ${dim}${r.owner}${reset}` : "";
    console.log(
      `  ${bold}${r.repoName}/${r.name}${reset}  ${dim}${r.state ?? r.kind}${reset}  ${cyan}${r.branch ?? "(detached)"}${reset}${ownerPart}${mrPart}${dupPart}`,
    );
  }
  console.log("");
}

// ─── freshen ─────────────────────────────────────────────────────────────────

export async function worktreeFreshen(args: string[], _ctx: unknown): Promise<void> {
  const parsed = parseFreshenArgs(args);
  let treeName = parsed.tree;
  let repoName = parsed.repoName;

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

  const res = await daemonQuery("worktree:adopt", { repoName: parsed.repoName }, ADOPT_TIMEOUT_MS);
  const ok = requireQueryResult(parsed.json, res);

  if (parsed.json) { console.log(JSON.stringify(ok.data, null, 2)); return; }

  const d = ok.data as { main: string; claimed: string[]; disposed: string[]; refused: Array<{ tree: string; reason: string }> };
  console.log("");
  console.log(`  ${green}✓${reset} adopted ${d.main ? `main=${d.main}, ` : ""}${d.claimed.length} claimed, ${d.disposed.length} disposed`);
  for (const r of d.refused) console.log(`  ${yellow}⚠${reset} ${r.tree} not disposed: ${r.reason}`);
  console.log("");
}

// ─── bare `rt worktree` nav picker ────────────────────────────────────────────

/**
 * Bare `rt worktree` — same contract as `rt cd`: redirect stdout while the
 * picker is up, print only the selected path to stdout on success so a shell
 * wrapper can `cd` into it.
 */
export async function worktreeNav(_args: string[], _ctx: unknown): Promise<void> {
  // Redirect FIRST, before any output at all — real stdout is reserved for
  // the one line the shell wrapper reads (the selected path). Every early
  // exit below (daemon down, refusal, empty list) goes through console.log,
  // which now lands on stderr too, same as cd.ts's contract.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const restore = (): void => { process.stdout.write = realStdoutWrite; };

  let selected: string | null;
  try {
    const res = await daemonQuery("worktree:list");
    if (res === null) { restore(); daemonUnavailable(); }
    if (!res.ok) {
      restore();
      console.log(`\n  ${red}✗${reset} ${explainError(res.error ?? "unknown error")}\n`);
      process.exit(1);
    }
    const rows = (res.data?.trees ?? []) as TreeRow[];
    if (rows.length === 0) { restore(); console.log(`\n  ${dim}no worktrees${reset}\n`); return; }

    const { filterableSelect } = await import("../lib/rt-render.tsx");
    const nameWidth = Math.max(...rows.map((r) => r.name.length));
    const stateWidth = Math.max(...rows.map((r) => (r.state ?? r.kind).length));
    const branchWidth = Math.max(...rows.map((r) => (r.branch ?? "(detached)").length));
    const options = rows.map((r) => ({
      value: r.path,
      label: `${r.name.padEnd(nameWidth)}  ${(r.state ?? r.kind).padEnd(stateWidth)}  ${(r.branch ?? "(detached)").padEnd(branchWidth)}  ${r.owner ?? ""}`,
    }));
    selected = await filterableSelect({ message: "Jump to worktree", options, stderr: true });
  } finally {
    restore();
  }

  if (!selected) process.exit(0);
  realStdoutWrite(selected + "\n");
}

// ─── park is gone ────────────────────────────────────────────────────────────

export async function parkDeprecated(_args: string[], _ctx: unknown): Promise<void> {
  console.log(`\n  ${red}✗${reset} rt park is gone — the parking lot was replaced by rt worktree (provision/dispose/list). See RT-34.\n`);
  process.exit(1);
}

// ─── each ────────────────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.log(`  ${red}✗${reset} ${msg}\n`);
  process.exit(1);
}

function loadRepos(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(RT_DIR, "repos.json"), "utf8"));
  } catch {
    return {};
  }
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
  const repoPath = repos[identity.repoName];
  if (!repoPath) fail(`repo "${identity.repoName}" not registered in ~/.rt/repos.json`);

  const bindings = (await bindingsFromDaemon(identity.repoName)) ?? bindingsFromGit(repoPath);
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
    const { filterableMultiselect } = await import("../lib/rt-render.tsx");
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
