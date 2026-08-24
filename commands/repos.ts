/**
 * rt repos register — add repo paths to the global index, optionally
 * granting background tracking in the same call.
 *
 *   rt repos register <path…> [--track live|poll] [--caches branches,project-mrs] [--json]
 *
 * All-or-nothing: every path is resolved and verified as a real git repo
 * before ANY write happens, so a bad path among several never leaves an
 * earlier one half-registered (indexed but missing the tracking grant the
 * same call asked for).
 *
 * Used standalone and by the apply engine's repos.clone step.
 */

import { execFileSync } from "child_process";
import { realpathSync } from "fs";
import { homedir } from "os";
import { basename } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { pruneRepoIndex, updateRepoIndex, type PrunedEntry } from "../lib/repo-index.ts";
import { CACHE_KINDS, loadMachineRepoTrackingRaw, parseCachesArg, saveRepoTrackingRaw, type CacheKind, type TrackingMode } from "../lib/repo-tracking.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";

export interface RegisterDeps {
  print: (s: string) => void;
}

export function realRegisterDeps(): RegisterDeps {
  return { print: (s) => console.log(s) };
}

const USAGE = "usage: rt repos register <path…> [--track live|poll] [--caches branches,project-mrs] [--json]";

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Strips --track/--caches/--json (and their values); every remaining non-flag token is a path. */
function positionalPaths(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--track" || a === "--caches") {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    result.push(a);
  }
  return result;
}

function resolveRealpath(inputPath: string): string | null {
  try {
    return realpathSync(inputPath);
  } catch {
    return null;
  }
}

function isGitRepo(path: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export async function reposRegister(args: string[], _ctx: CommandContext = {}, deps: RegisterDeps = realRegisterDeps()): Promise<void> {
  const json = args.includes("--json");
  const track = flagValue(args, "--track");
  const cachesArg = flagValue(args, "--caches");
  const paths = positionalPaths(args);

  if (paths.length === 0) {
    exitUserError(new UserActionableError("usage", USAGE), json, "repos register", deps.print);
  }
  if (track !== undefined && track !== "live" && track !== "poll") {
    exitUserError(new UserActionableError("usage", `--track must be "live" or "poll" (got "${track}")`), json, "repos register", deps.print);
  }

  let caches: CacheKind[] | null = null;
  if (track) {
    caches = parseCachesArg(cachesArg ?? "branches");
    if (!caches) {
      exitUserError(
        new UserActionableError("usage", `unknown cache name in "${cachesArg}" (valid: ${CACHE_KINDS.join(", ")})`),
        json,
        "repos register",
        deps.print,
      );
    }
  }

  // Validation pass FIRST, no writes yet: a bad path later in the list must
  // never leave an earlier one indexed without the tracking grant this same
  // call asked for.
  const resolved: { name: string; real: string }[] = [];
  for (const inputPath of paths) {
    const real = resolveRealpath(inputPath);
    if (real === null) {
      exitUserError(new UserActionableError("bad-path", `"${inputPath}" does not exist`), json, "repos register", deps.print);
    }
    if (!isGitRepo(real)) {
      exitUserError(new UserActionableError("not-a-git-repo", `"${inputPath}" is not a git repository`), json, "repos register", deps.print);
    }
    resolved.push({ name: basename(real), real });
  }

  type Registered = { name: string; path: string; tracking: { mode: TrackingMode; caches: CacheKind[] } | null };
  const registered: Registered[] = [];
  // A read-modify-write must start from the RAW machine map, never a merged
  // loadRepoTracking() read — writing that back would erase every other
  // repo's raw entry (a typo'd mode, or an explicit off-marker) that this
  // call never meant to touch.
  const rawTracking = track ? loadMachineRepoTrackingRaw() : null;

  for (const { name, real } of resolved) {
    updateRepoIndex(name, real);

    let tracking: Registered["tracking"] = null;
    if (track && caches && rawTracking) {
      tracking = { mode: track, caches };
      rawTracking[name] = tracking;
    }
    registered.push({ name, path: real, tracking });
  }

  if (rawTracking) saveRepoTrackingRaw(rawTracking);

  if (json) {
    deps.print(JSON.stringify(envelope({ registered })));
    return;
  }
  for (const r of registered) {
    deps.print(
      r.tracking
        ? `registered ${r.name} (${r.path}) — tracking ${r.tracking.mode} [${r.tracking.caches.join(",")}]`
        : `registered ${r.name} (${r.path})`,
    );
  }
}

// ─── prune ───────────────────────────────────────────────────────────────────

const PRUNE_USAGE = "usage: rt repos prune [--dry-run] [--json]";

function describeReason(r: PrunedEntry): string {
  return r.reason === "duplicate" ? `same directory as ${r.keptAs}` : "path no longer exists";
}

/**
 * rt repos prune — drop index rows that no longer name anything: a path that
 * has stopped existing, and the losing half of every realpath collision left
 * behind by a repo rename.
 *
 * `getKnownRepos` already hides both from the picker; this is the deliberate
 * eviction, kept a separate explicit verb because a name lookup elsewhere
 * (`loadRepoIndex()[name]`, per-repo data dirs, per-repo settings scopes)
 * still resolves through the row this removes. RT-60 is the migration that
 * would carry those forward instead of stranding them.
 */
export async function reposPrune(args: string[], _ctx: CommandContext = {}, deps: RegisterDeps = realRegisterDeps()): Promise<void> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");

  for (const a of args) {
    if (a.startsWith("--") && a !== "--json" && a !== "--dry-run") {
      exitUserError(new UserActionableError("usage", `unknown flag "${a}" — ${PRUNE_USAGE}`), json, "repos prune", deps.print);
    }
  }

  const removed = pruneRepoIndex({ dryRun });

  if (json) {
    deps.print(JSON.stringify(envelope({ removed, dryRun })));
    return;
  }
  if (removed.length === 0) {
    deps.print("repo index is clean — nothing to prune");
    return;
  }
  const verb = dryRun ? "would remove" : "removed";
  for (const r of removed) {
    deps.print(`${verb} ${r.repoName} (${r.path.replace(homedir(), "~")}) — ${describeReason(r)}`);
  }
}
