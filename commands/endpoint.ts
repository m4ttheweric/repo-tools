#!/usr/bin/env bun

/**
 * rt endpoint: surface over dev-endpoint claims (RT-28 Task 7; `release`
 * added in S068 as the manual escape hatch for a claim liveness can't clear
 * on its own).
 *
 *   rt endpoint lookup <role> [--path <dir>] [--json]   does this worktree hold a claim?
 *   rt endpoint release <worktree> [--role]             free a claim by hand
 *
 * Repo identification mirrors the pattern already used by `rt worktree each`
 * (commands/worktree.ts): derive the repo identity from the cwd's git
 * toplevel + remote, then check its serialized form is a KEY in
 * ~/.mattstack/rt/repos.json — read the same way `lib/endpoint/shim.ts`'s
 * `buildInterceptRules` reads it. An unregistered repo is a clear, fail-loud
 * error (there is nothing to fall open to for a read-only lookup). The git
 * toplevel path string IS the worktree key `endpoint:lookup` expects — the
 * same value the daemon's disposal release receives as `path`.
 */

import { basename } from "path";
import { dim, green, red, reset, yellow } from "../lib/tui.ts";
import { canon } from "../lib/fs-canon.ts";
import { resolveIndexPathForIdentity } from "../lib/repo-index.ts";
import { runCapture } from "../lib/subprocess.ts";
import { daemonQuery } from "../lib/daemon-client.ts";
import { loadEndpointConfig } from "../lib/endpoint/config.ts";
// deriveRepoName, not getRepoIdentity: the latter's updateRepoIndex side
// effect would write to the repo index from a read-only lookup.
import { deriveRepoName } from "../lib/repo.ts";
// deriveRepoIdentity (not getRepoIdentity) for the same reason — pure
// derivation, no repo-index write.
import { deriveRepoIdentity, serializeIdentity } from "../lib/settings/identity.ts";

function fail(msg: string): never {
  console.error(`rt endpoint: ${msg}`);
  process.exit(1);
}

async function gitToplevel(cwd: string): Promise<string | null> {
  const res = await runCapture(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  if (res.exitCode !== 0) return null;
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function gitRemote(toplevel: string): Promise<string | null> {
  const res = await runCapture(["git", "-C", toplevel, "config", "--get", "remote.origin.url"]);
  if (res.exitCode !== 0) return null;
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface LookupWorktree {
  path: string;
  name: string | null;
}

interface LookupListener {
  pid: number;
  command: string;
  cwd: string | null;
  ownsClaim: boolean | null;
}

interface LookupData {
  claimed: boolean;
  port: number | null;
  url: string | null;
  running: boolean;
  /** Absent when the daemon predates RT-115 — buildLookupOutput falls back to the CLI's own resolution. */
  worktree?: LookupWorktree;
  listener?: LookupListener | null;
}

export interface ParsedEndpointLookupArgs {
  role: string | undefined;
  path: string | undefined;
  /** `--path` was present but its value was missing or itself another flag: a real path must never be silently treated as omitted. */
  pathInvalid: boolean;
}

/** Pure arg parse for `rt endpoint lookup`, same shape (and same index-exclusion subtlety) as parseEndpointReleaseArgs below. */
export function parseEndpointLookupArgs(args: string[]): ParsedEndpointLookupArgs {
  const inlineIdx = args.findIndex((a) => a.startsWith("--path="));
  if (inlineIdx !== -1) {
    const inline = args[inlineIdx]!.slice("--path=".length);
    const roleArgs = args.filter((a) => !a.startsWith("--"));
    return { role: roleArgs[0], path: inline.length > 0 ? inline : undefined, pathInvalid: inline.length === 0 };
  }
  const pathFlagIdx = args.indexOf("--path");
  const pathValueIdx = pathFlagIdx === -1 ? -1 : pathFlagIdx + 1;
  const pathValue = pathFlagIdx !== -1 ? args[pathValueIdx] : undefined;
  const pathInvalid = pathFlagIdx !== -1 && (pathValue === undefined || pathValue.startsWith("--"));
  const path = pathInvalid ? undefined : pathValue;
  const roleArgs = args.filter((a, i) => i !== pathFlagIdx && i !== pathValueIdx && !a.startsWith("--"));
  return { role: roleArgs[0], path, pathInvalid };
}

export interface LookupCliContext {
  role: string;
  repoName: string;
  toplevel: string;
  /** Canonical main-checkout path from the repo index; null only when unknown. */
  indexPath: string | null;
}

/**
 * Composes both output modes from one decision pass (RT-115): the --json
 * payload (daemon data plus `worktree.main`) and the plain lines, which name
 * the resolved worktree and shout when the listening process is not the
 * claim's own.
 */
export function buildLookupOutput(
  data: LookupData,
  ctx: LookupCliContext,
): { payload: Record<string, unknown>; lines: string[] } {
  const main = ctx.indexPath !== null && canon(ctx.toplevel) === canon(ctx.indexPath);
  const worktree = { ...(data.worktree ?? { path: ctx.toplevel, name: null }), main };
  const listener = data.listener ?? null;
  const payload = { ok: true, ...data, worktree, listener };

  const lines: string[] = [];
  const treeLabel = worktree.name !== null ? `${worktree.name} (${worktree.path})` : worktree.path;

  if (!data.claimed) {
    lines.push(`${dim}no claim for role "${ctx.role}" in ${ctx.repoName}${reset}`);
  } else {
    const foreign = listener !== null && listener.ownsClaim === false;
    const status = foreign
      ? "port taken"
      : listener !== null
        ? "running"
        : data.running
          ? "claimed, process alive, not listening yet"
          : "claimed, not running";
    const statusColor = foreign ? red : listener !== null ? green : yellow;
    lines.push(`${statusColor}${data.url}${reset} ${dim}(${status})${reset}`);
  }

  lines.push(`${dim}worktree ${treeLabel}${reset}`);

  if (listener !== null && listener.ownsClaim === false) {
    const where = listener.cwd !== null ? `, ${listener.cwd}` : "";
    lines.push(
      `${red}⚠ port ${data.port} is listening, but pid ${listener.pid} (${listener.command}${where}) does not belong to this worktree${reset}`,
    );
  } else if (listener !== null && listener.ownsClaim === null) {
    lines.push(`${yellow}the listening process (pid ${listener.pid}, ${listener.command}) could not be attributed to a worktree${reset}`);
  }

  if (main) {
    lines.push(`${yellow}⚠ running from the canonical main checkout, not a claimed worktree${reset}`);
  }

  return { payload, lines };
}

async function pickRole(cwd: string): Promise<string | null> {
  const toplevel = await gitToplevel(cwd);
  if (toplevel) {
    const remote = await gitRemote(toplevel);
    const repoName = remote ? deriveRepoName(remote) : basename(toplevel);
    const identity = await deriveRepoIdentity(toplevel);
    const repoIdentity = identity.kind === "remote" ? identity.id : null;
    const roles = Object.keys(loadEndpointConfig({ repoIdentity, repoName }).roles);
    if (roles.length > 0) {
      const { filterableSelect } = await import("../lib/pick-wrappers.ts");
      return filterableSelect({
        message: `endpoint role in ${repoName}`,
        options: roles.map((r) => ({ value: r, label: r })),
      });
    }
  }
  fail("usage: rt endpoint lookup <role> [--path <dir>] [--json]");
}

export async function endpointLookup(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const parsed = parseEndpointLookupArgs(args);
  if (parsed.pathInvalid) fail("--path needs a value (usage: rt endpoint lookup <role> [--path <dir>] [--json])");
  const cwd = parsed.path ?? process.cwd();
  let role = parsed.role;
  if (!role) {
    if (process.stdin.isTTY && !json && !process.env.RT_BATCH) {
      role = (await pickRole(cwd)) ?? undefined;
      if (!role) process.exit(0);
    } else {
      fail("usage: rt endpoint lookup <role> [--path <dir>] [--json]");
    }
  }

  const toplevel = await gitToplevel(cwd);
  if (!toplevel) fail(parsed.path ? `--path ${parsed.path} is not in a git repo` : "not in a git repo");

  const remote = await gitRemote(toplevel);
  const repoName = remote ? deriveRepoName(remote) : basename(toplevel);
  // The repo index and the endpoint_claims table both key on the serialized
  // identity now — the same value buildInterceptRules' endpoint:claim payload
  // sends, so a claim made through an intercepted command and a lookup made
  // here hit the same row. repoName above stays around for display only.
  const identity = serializeIdentity(await deriveRepoIdentity(toplevel));

  // Identity is a KEY, not a path match (a secondary worktree's toplevel
  // never equals the index's stored primary path, so equality-matching the
  // path would false-negative every time). resolveIndexPathForIdentity also
  // accepts a legacy name-keyed row for this repo — migrating it, not
  // registering: a repo in neither form still fails.
  const indexPath = await resolveIndexPathForIdentity(identity);
  if (indexPath === null) {
    fail(`repo "${repoName}" is not registered — visit it with rt first (repos.json is a derived mirror, not the source of truth)`);
  }

  const res = await daemonQuery("endpoint:lookup", { repo: identity, worktree: toplevel, role }, 10_000);
  if (!res) fail("daemon unavailable — rt endpoint lookup needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "lookup failed");

  const { payload, lines } = buildLookupOutput(res.data as LookupData, { role, repoName, toplevel, indexPath });

  if (json) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log(`\n  ${lines.join("\n  ")}\n`);
}

interface ReleaseData {
  released: number;
}

/** Lists the worktrees this repo currently has claims for, over the daemon's own `endpoint:status` (a picker source, not a state read). */
async function pickWorktree(identity: string): Promise<string | null> {
  const res = await daemonQuery("endpoint:status", { repo: identity }, 10_000);
  if (!res?.ok) return null;
  const data = res.data as { repos: Record<string, Array<{ worktree: string }>> };
  const worktrees = [...new Set((data.repos[identity] ?? []).map((c) => c.worktree))];
  if (worktrees.length === 0) fail("no claims to release");
  const { filterableSelect } = await import("../lib/pick-wrappers.ts");
  return filterableSelect({
    message: "worktree to release",
    options: worktrees.map((w) => ({ value: w, label: w })),
  });
}

export interface ParsedEndpointReleaseArgs {
  worktree: string | undefined;
  role: string | undefined;
  /** `--role` was present but its value was missing or itself another flag (e.g. `--role --json`): a real role must never be silently treated as omitted. */
  roleInvalid: boolean;
}

/**
 * Pure arg parse for `rt endpoint release`, split out so the --role-absent
 * case (roleFlagIdx === -1) is unit-testable without a git repo or daemon.
 * roleFlagIdx + 1 must only be excluded from worktreeArgs when --role is
 * actually present, or index 0 (the worktree itself) gets filtered out.
 */
export function parseEndpointReleaseArgs(args: string[]): ParsedEndpointReleaseArgs {
  const roleFlagIdx = args.indexOf("--role");
  const roleValueIdx = roleFlagIdx === -1 ? -1 : roleFlagIdx + 1;
  const roleValue = roleFlagIdx !== -1 ? args[roleValueIdx] : undefined;
  const roleInvalid = roleFlagIdx !== -1 && (roleValue === undefined || roleValue.startsWith("--"));
  const role = roleInvalid ? undefined : roleValue;
  const worktreeArgs = args.filter((a, i) => i !== roleFlagIdx && i !== roleValueIdx && !a.startsWith("--"));
  return { worktree: worktreeArgs[0], role, roleInvalid };
}

/**
 * Manual escape hatch (S068): frees a worktree's endpoint claim(s) directly,
 * for the case a recycled pid or a wedged process leaves a claim liveness
 * can't clear on its own. Repo identity is always the cwd's; `<worktree>` is
 * the claim to drop and need not be the cwd itself (that is the whole point
 * of a manual release).
 */
export async function endpointRelease(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const parsed = parseEndpointReleaseArgs(args);
  if (parsed.roleInvalid) fail("--role needs a value (usage: rt endpoint release <worktree> --role <role>)");
  const role = parsed.role;
  let worktree = parsed.worktree;

  const cwd = process.cwd();
  const toplevel = await gitToplevel(cwd);
  if (!toplevel) fail("not in a git repo");

  const remote = await gitRemote(toplevel);
  const repoName = remote ? deriveRepoName(remote) : basename(toplevel);
  const identity = serializeIdentity(await deriveRepoIdentity(toplevel));

  if ((await resolveIndexPathForIdentity(identity)) === null) {
    fail(`repo "${repoName}" is not registered... visit it with rt first (repos.json is a derived mirror, not the source of truth)`);
  }

  if (!worktree) {
    if (process.stdin.isTTY && !json && !process.env.RT_BATCH) {
      worktree = (await pickWorktree(identity)) ?? undefined;
      if (!worktree) process.exit(0);
    } else {
      fail("usage: rt endpoint release <worktree> [--role <role>] [--json]");
    }
  }

  const res = await daemonQuery("endpoint:release", { repo: identity, worktree, role }, 10_000);
  if (!res) fail("daemon unavailable... rt endpoint release needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "release failed");

  const data = res.data as ReleaseData;

  if (json) {
    console.log(JSON.stringify({ ok: true, ...data }));
    return;
  }

  if (data.released === 0) {
    console.log(`\n  ${dim}no claim(s) to release for ${worktree}${role ? ` (role "${role}")` : ""} in ${repoName}${reset}\n`);
    return;
  }
  console.log(`\n  ${green}released ${data.released} claim${data.released === 1 ? "" : "s"}${reset} ${dim}for ${worktree} in ${repoName}${reset}\n`);
}
