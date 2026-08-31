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
import { getKnownRepos, pruneRepoIndex, updateRepoIndexAsync, type PrunedEntry } from "../lib/repo-index.ts";
import { deriveRepoIdentity, serializeIdentity } from "../lib/settings/identity.ts";
import { CACHE_KINDS, loadMachineRepoTrackingRaw, parseCachesArg, saveRepoTrackingRaw, type CacheKind, type TrackingMode } from "../lib/repo-tracking.ts";
import { envelope } from "../lib/setup/contract.ts";
import { UserActionableError, exitUserError } from "../lib/setup/errors.ts";
import { findLocateCandidates } from "../lib/repo-locate.ts";
import { locateMovedRepo } from "../lib/repo-locate-dispatch.ts";
import { resolveRepoArg } from "../lib/repo-arg.ts";
import { repoLabel } from "../lib/repo-label.ts";

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
  let paths = positionalPaths(args);

  if (paths.length === 0) {
    const picked =
      process.stdin.isTTY && !json && !process.env.RT_BATCH ? await pickRegisterTarget() : undefined;
    if (picked === undefined) {
      exitUserError(new UserActionableError("usage", USAGE), json, "repos register", deps.print);
    }
    if (picked === null) process.exit(0);
    paths = [picked];
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
  const resolved: { name: string; real: string; identity: string }[] = [];
  for (const inputPath of paths) {
    const real = resolveRealpath(inputPath);
    if (real === null) {
      exitUserError(new UserActionableError("bad-path", `"${inputPath}" does not exist`), json, "repos register", deps.print);
    }
    if (!isGitRepo(real)) {
      exitUserError(new UserActionableError("not-a-git-repo", `"${inputPath}" is not a git repository`), json, "repos register", deps.print);
    }
    // deriveRepoIdentity only shells out to git for the remote — read-only,
    // so it belongs in the validation pass alongside the other checks.
    const identity = serializeIdentity(await deriveRepoIdentity(real));
    resolved.push({ name: basename(real), real, identity });
  }

  type Registered = { name: string; path: string; tracking: { mode: TrackingMode; caches: CacheKind[] } | null };
  const registered: Registered[] = [];
  // A read-modify-write must start from the RAW machine map, never a merged
  // loadRepoTracking() read — writing that back would erase every other
  // repo's raw entry (a typo'd mode, or an explicit off-marker) that this
  // call never meant to touch.
  const rawTracking = track ? loadMachineRepoTrackingRaw() : null;

  for (const { name, real, identity } of resolved) {
    // A refused move leaves the row naming the gone path, so printing
    // "registered" (or a JSON ok envelope) here would tell a script the repo
    // is indexed at `real` when nothing points there.
    const indexed = await updateRepoIndexAsync(identity, real);
    if (!indexed.ok) {
      exitUserError(
        new UserActionableError(
          "locate-failed",
          `"${name}" is indexed at a path that no longer exists, and moving it to ${real} failed — ${indexed.error}`,
        ),
        json,
        "repos register",
        deps.print,
      );
    }

    let tracking: Registered["tracking"] = null;
    if (track && caches && rawTracking) {
      tracking = { mode: track, caches };
      rawTracking[identity] = tracking;
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

/**
 * No `<path…>`: offer the git repos discovered under `rt.repoRoots` that are
 * not yet indexed. `undefined` when the scan turns up none (the caller falls
 * through to the usage error, never an empty picker); `null` when cancelled.
 */
async function pickRegisterTarget(): Promise<string | null | undefined> {
  const candidates = getKnownRepos().filter((r) => r.registered === false && r.worktrees[0]);
  if (candidates.length === 0) return undefined;

  const { filterableSelect } = await import("../lib/rt-render.tsx");
  return filterableSelect({
    message: "Which repo should rt register?",
    options: candidates.map((r) => ({
      value: r.worktrees[0]!.path,
      label: r.worktrees[0]!.path.replace(homedir(), "~"),
      hint: r.repoName,
    })),
    stderr: true,
  });
}

// ─── prune ───────────────────────────────────────────────────────────────────

const PRUNE_USAGE = "usage: rt repos prune [--dry-run] [--json]";

function describeReason(r: PrunedEntry): string {
  return r.reason === "duplicate" ? `same directory as ${r.keptAs}` : "path no longer exists";
}

/**
 * What the retired name's data dir did, as a trailing clause. Refusals are
 * named individually — they are the only outcome that leaves the operator
 * something to do.
 */
function describeDataMove(r: PrunedEntry, dryRun: boolean): string {
  const d = r.data;
  if (!d) return "";
  const carried = d.moved.length + d.merged.length;
  const parts: string[] = [];
  if (carried > 0) parts.push(`${dryRun ? "would carry" : "carried"} ${carried} file${carried === 1 ? "" : "s"} to ${r.keptAs}`);
  if (d.merged.length > 0) parts.push(`merged ${d.merged.join(", ")}`);
  if (d.registry === "moved") parts.push(`${dryRun ? "would move" : "moved"} the worktree registry to ${r.keptAs}`);
  if (d.registry === "merged") parts.push(`${dryRun ? "would merge" : "merged"} the worktree registry into ${r.keptAs}'s`);
  if (d.registry === "refused") parts.push(`${r.keptAs}'s worktree registry could not be written — both kept`);
  if (d.refused.length > 0) parts.push(`kept both copies of ${d.refused.join(", ")}`);
  return parts.length > 0 ? `; ${parts.join("; ")}` : "";
}

/**
 * rt repos prune — drop index rows that no longer name anything: a path that
 * has stopped existing, and the losing half of every realpath collision left
 * behind by a repo rename.
 *
 * `getKnownRepos` already hides both from the picker; this is the deliberate
 * eviction, kept an explicit verb because it also carries the retired name's
 * data dir onto the surviving name — moving one repo's data onto another is
 * not something to infer from a derived-name change nobody asked about.
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
  for (const r of removed) {
    const verb = r.retained ? "kept" : dryRun ? "would remove" : "removed";
    const why = r.retained
      ? r.reason === "missing"
        ? `${describeReason(r)} but it still owns a worktree registry — keeping the row; run: ${r.hint} <new-path> --repo ${r.repoName}`
        : `${describeReason(r)}, but its data could not all move${describeDataMove(r, dryRun)} — keeping the row so nothing is orphaned`
      : `${describeReason(r)}${describeDataMove(r, dryRun)}`;
    deps.print(`${verb} ${repoLabel(r.repoName)} (${r.path.replace(homedir(), "~")}) — ${why}`);
  }
}

// ─── locate ──────────────────────────────────────────────────────────────────

const LOCATE_USAGE = "usage: rt repos locate [<new-path>] [--repo <id|name>] [--dry-run] [--json]";
const LOCATE_FLAGS = ["--json", "--dry-run", "--repo"];

/** Every non-flag token that is not `--repo`'s value. */
function locatePositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repo") {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

/**
 * rt repos locate — tell rt where a repo moved to.
 *
 * A folder move keeps the repo identity but leaves every stored path stale.
 * The daemon owns the apply whenever it answers; a local apply only happens
 * when nothing is up to race.
 */
export async function reposLocate(args: string[], _ctx: CommandContext = {}, deps: RegisterDeps = realRegisterDeps()): Promise<void> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  for (const a of args) {
    if (a.startsWith("--") && !LOCATE_FLAGS.includes(a)) {
      exitUserError(new UserActionableError("usage", `unknown flag "${a}" — ${LOCATE_USAGE}`), json, "repos locate", deps.print);
    }
  }

  const repoArg = flagValue(args, "--repo");
  if (args.includes("--repo") && (repoArg === undefined || repoArg.startsWith("--"))) {
    exitUserError(new UserActionableError("usage", `--repo needs a value — ${LOCATE_USAGE}`), json, "repos locate", deps.print);
  }
  const repo = repoArg
    ? await resolveRepoArg(repoArg, (msg) =>
        exitUserError(new UserActionableError("repo-unknown", msg), json, "repos locate", deps.print))
    : undefined;

  const positionals = locatePositionals(args);
  if (positionals.length > 1) {
    exitUserError(
      new UserActionableError("usage", `locate takes one path, got ${positionals.length} (${positionals.join(", ")}) — ${LOCATE_USAGE}`),
      json,
      "repos locate",
      deps.print,
    );
  }

  const newPath = positionals[0] ?? (await pickLocateTarget(json, deps));

  const outcome = await locateMovedRepo({ newPath, ...(repo ? { repo } : {}), dryRun });
  if (!outcome.ok) {
    exitUserError(new UserActionableError("refused", outcome.error), json, "repos locate", deps.print);
  }

  if (outcome.dryRun) {
    const p = outcome.plan;
    if (json) {
      deps.print(JSON.stringify(envelope({ plan: p, dryRun: true })));
      return;
    }
    deps.print(`would move ${p.identity} from ${p.oldPath} to ${p.newPath}`);
    deps.print(`  index rows: ${p.indexKeys.join(", ")}`);
    deps.print(`  worktree records: ${p.registryRewrites.reduce((n, r) => n + r.movedPaths.length, 0)}`);
    deps.print(`  endpoint claims: ${p.claimRewrites.length}`);
    deps.print(`  git worktree repair: ${p.gitRepairPaths.length === 0 ? "(main worktree only)" : p.gitRepairPaths.join(", ")}`);
    return;
  }

  const r = outcome.result;
  if (json) {
    deps.print(JSON.stringify(envelope({ located: r, via: outcome.via })));
    return;
  }
  deps.print(`located ${r.identity}: ${r.from} → ${r.to}`);
  deps.print(`  ${r.treesRewritten} worktree record${r.treesRewritten === 1 ? "" : "s"}, ${r.claimsRewritten} endpoint claim${r.claimsRewritten === 1 ? "" : "s"}, ${r.repaired.length} tree${r.repaired.length === 1 ? "" : "s"} repaired`);
  for (const stale of r.stalePaths) deps.print(`  stale record kept for the reconciler to prune: ${stale}`);
  for (const row of r.legacyRows) {
    deps.print(row.outcome === "collapsed"
      ? `  collapsed the legacy row ${row.key}`
      : `  kept the legacy row ${row.key}, still naming ${r.from} — ${row.reason || "its data dir could not all move"}`);
  }
}

/**
 * No `<new-path>`: propose, never auto-pick. One candidate still asks; several
 * open a picker; none is a hard stop that names what is lost.
 */
async function pickLocateTarget(json: boolean, deps: RegisterDeps): Promise<string> {
  const lost = getKnownRepos({ includeMissing: true }).filter((r) => r.missing);
  if (lost.length === 0) {
    deps.print(json ? JSON.stringify(envelope({ lost: [], candidates: [] })) : "no indexed repo is missing — nothing to locate");
    process.exit(1);
  }

  const candidates = await findLocateCandidates();
  if (candidates.length === 0 || !process.stdin.isTTY) {
    if (json) {
      deps.print(JSON.stringify(envelope({ lost: lost.map((r) => ({ repo: r.repoName, path: r.worktrees[0]?.path })), candidates })));
    } else {
      deps.print("missing repos:");
      for (const r of lost) deps.print(`  ${repoLabel(r.repoName)} — last seen at ${r.worktrees[0]?.path}`);
      deps.print(candidates.length === 0
        ? `pass the new path: ${LOCATE_USAGE}`
        : "run interactively to pick a candidate, or pass the new path");
    }
    process.exit(1);
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    const { confirm } = await import("../lib/rt-render.tsx");
    const ok = await confirm({ message: `Locate ${only.identity} at ${only.path}?`, stderr: true });
    if (!ok) process.exit(0);
    return only.path;
  }

  const { filterableSelect } = await import("../lib/rt-render.tsx");
  const picked = await filterableSelect({
    message: "Which directory did it move to?",
    options: candidates.map((c) => ({ value: c.path, label: c.path, hint: c.identity })),
    stderr: true,
  });
  if (!picked) process.exit(0);
  return picked;
}
