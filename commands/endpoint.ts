#!/usr/bin/env bun

/**
 * rt endpoint: surface over dev-endpoint claims (RT-28 Task 7; `release`
 * added in S068 as the manual escape hatch for a claim liveness can't clear
 * on its own).
 *
 *   rt endpoint lookup <role> [--json]        does this worktree hold a claim?
 *   rt endpoint release <worktree> [--role]   free a claim by hand
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
import { dim, green, reset, yellow } from "../lib/tui.ts";
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

interface LookupData {
  claimed: boolean;
  port: number | null;
  url: string | null;
  running: boolean;
}

async function pickRole(): Promise<string | null> {
  const toplevel = await gitToplevel(process.cwd());
  if (toplevel) {
    const remote = await gitRemote(toplevel);
    const repoName = remote ? deriveRepoName(remote) : basename(toplevel);
    const identity = await deriveRepoIdentity(toplevel);
    const repoIdentity = identity.kind === "remote" ? identity.id : null;
    const roles = Object.keys(loadEndpointConfig({ repoIdentity, repoName }).roles);
    if (roles.length > 0) {
      const { filterableSelect } = await import("../lib/rt-render.tsx");
      return filterableSelect({
        message: `endpoint role in ${repoName}`,
        options: roles.map((r) => ({ value: r, label: r })),
      });
    }
  }
  fail("usage: rt endpoint lookup <role> [--json]");
}

export async function endpointLookup(args: string[]): Promise<void> {
  const json = args.includes("--json");
  let role = args.find((a) => !a.startsWith("--"));
  if (!role) {
    if (process.stdin.isTTY && !json && !process.env.RT_BATCH) {
      role = (await pickRole()) ?? undefined;
      if (!role) process.exit(0);
    } else {
      fail("usage: rt endpoint lookup <role> [--json]");
    }
  }

  const cwd = process.cwd();
  const toplevel = await gitToplevel(cwd);
  if (!toplevel) fail("not in a git repo");

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
  if ((await resolveIndexPathForIdentity(identity)) === null) {
    fail(`repo "${repoName}" is not registered — visit it with rt first (repos.json is a derived mirror, not the source of truth)`);
  }

  const res = await daemonQuery("endpoint:lookup", { repo: identity, worktree: toplevel, role }, 10_000);
  if (!res) fail("daemon unavailable — rt endpoint lookup needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "lookup failed");

  const data = res.data as LookupData;

  if (json) {
    console.log(JSON.stringify({ ok: true, ...data }));
    return;
  }

  if (!data.claimed) {
    console.log(`\n  ${dim}no claim for role "${role}" in ${repoName}${reset}\n`);
    return;
  }
  const statusColor = data.running ? green : yellow;
  console.log(`\n  ${statusColor}${data.url}${reset} ${dim}(${data.running ? "running" : "claimed, not running"})${reset}\n`);
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
  const { filterableSelect } = await import("../lib/rt-render.tsx");
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
