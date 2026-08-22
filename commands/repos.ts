/**
 * rt repos register — add repo paths to the global index, optionally
 * granting background tracking in the same call.
 *
 *   rt repos register <path…> [--track live|poll] [--caches branches,project-mrs] [--json]
 *
 * Used standalone and by the apply engine's repos.clone step.
 */

import { realpathSync } from "fs";
import { basename } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { updateRepoIndex } from "../lib/repo-index.ts";
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

  type Registered = { name: string; path: string; tracking: { mode: TrackingMode; caches: CacheKind[] } | null };
  const registered: Registered[] = [];
  // A read-modify-write must start from the RAW machine map, never a merged
  // loadRepoTracking() read — writing that back would erase every other
  // repo's raw entry (a typo'd mode, or an explicit off-marker) that this
  // call never meant to touch.
  const rawTracking = track ? loadMachineRepoTrackingRaw() : null;

  for (const inputPath of paths) {
    const real = resolveRealpath(inputPath);
    if (real === null) {
      exitUserError(new UserActionableError("bad-path", `"${inputPath}" does not exist`), json, "repos register", deps.print);
    }
    const name = basename(real);
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
