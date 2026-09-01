/**
 * Runs the mattstack plugin's merge-manifests.sh against every REGISTERED
 * repo (never a repo `getKnownRepos()` only discovered by scanning
 * `rt.repoRoots` — those show up with `registered:false` and are excluded
 * here, matching the "not a registered repo" refusal text below), materializing
 * each repo's skills.jsonc binding manifest.
 *
 * Idempotent and re-callable, and NEVER throws for the ordinary fresh-machine
 * case: the apply engine's skills.materialize step runs before plugins.install
 * (contract order), so merge-manifests.sh is routinely absent the first time
 * this runs. That case comes back as `{skipped: true, reason}` — a future
 * plugins.install step handler MUST read `result.skipped` (not treat any
 * non-throw as success, and not treat this function throwing as the signal —
 * it deliberately doesn't throw for this case) and map it to a skipped/done
 * step state, then call `materializeSkills` again once the plugin is on disk.
 * This module holds no state of its own, so that repeat call is just a normal
 * rerun.
 */

import { join } from "path";
import { getKnownRepos, type KnownRepo } from "../repo-index.ts";
import { repoLabel } from "../repo-label.ts";
import { tryResolveRepoArg } from "../repo-arg.ts";
import { UserActionableError } from "./errors.ts";
import type { Probes } from "./probes.ts";

const CACHE_DIR_SEGMENTS = ["plugins", "cache", "mattstack", "mattstack"];
const SCRIPT_SEGMENTS = ["attachments", "parameterized-skills", "scripts", "merge-manifests.sh"];

/** Bounds the per-repo `merge-manifests.sh` call — it does real git work, so a wedged remote/auth prompt must time out (124) rather than hang the whole apply run. */
const MATERIALIZE_TIMEOUT_MS = 60_000;

/** The `reason` detail's stable prefix when merge-manifests.sh isn't installed yet — a future step handler may match on this instead of parsing prose. */
export const MERGE_MANIFESTS_MISSING_CODE = "merge-manifests-missing";

/** Dotted-numeric compare, missing segments treated as 0 — matches lib/setup/semver.ts's looseness; version dirs here are plain "x.y.z". */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** RT_MERGE_MANIFESTS env override, else the highest-semver installed mattstack plugin version's script; null when neither resolves (plugin not yet installed). */
export function findMergeManifests(p: Pick<Probes, "readDir" | "exists" | "home" | "env">): string | null {
  const override = p.env.RT_MERGE_MANIFESTS;
  if (override) return override;

  const versionsDir = join(p.home, ".claude", ...CACHE_DIR_SEGMENTS);
  let best: { version: string; path: string } | null = null;
  for (const version of p.readDir(versionsDir)) {
    const scriptPath = join(versionsDir, version, ...SCRIPT_SEGMENTS);
    if (!p.exists(scriptPath)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, path: scriptPath };
  }
  return best?.path ?? null;
}

export interface MaterializeRepoResult {
  name: string;
  path: string;
  ok: boolean;
  detail: string;
}

export type MaterializeSkillsResult =
  | { skipped: true; reason: string; repos: [] }
  | { skipped: false; repos: MaterializeRepoResult[] };

function registeredKnownRepos(): Pick<KnownRepo, "repoName" | "worktrees">[] {
  return getKnownRepos().filter((r) => r.registered !== false);
}

export async function materializeSkills(p: Probes, opts: { repo?: string }): Promise<MaterializeSkillsResult> {
  const script = findMergeManifests(p);
  if (!script) {
    return {
      skipped: true,
      reason: `${MERGE_MANIFESTS_MISSING_CODE}: install the mattstack plugin first (plugins.install), then rerun`,
      repos: [],
    };
  }

  const known = registeredKnownRepos();
  let targets: { name: string; path: string }[];
  if (opts.repo) {
    // Rows are keyed by serialized identity, so a typed name resolves to one
    // before matching. The raw-spelling fallback is for kind "none" ONLY: on an
    // ambiguous label a legacy row spelled that way would otherwise decide
    // which repo gets materialized.
    const resolution = await tryResolveRepoArg(opts.repo);
    if (resolution.kind === "ambiguous") {
      throw new UserActionableError("repo-ambiguous", `"${opts.repo}" matches more than one repo: ${resolution.matches.join(", ")}... pass the full identity`);
    }
    const match = resolution.kind === "resolved"
      ? known.find((r) => r.repoName === resolution.identity)
      : known.find((r) => r.repoName === opts.repo);
    if (!match) {
      throw new UserActionableError("repo-not-registered", `"${opts.repo}" is not a registered repo (rt repos register first)`);
    }
    targets = [{ name: repoLabel(match.repoName), path: match.worktrees[0]!.path }];
  } else {
    targets = known.map((r) => ({ name: repoLabel(r.repoName), path: r.worktrees[0]!.path }));
  }

  const mattstackHome = join(p.home, ".mattstack");
  const repos: MaterializeRepoResult[] = [];

  for (const target of targets) {
    const res = await p.exec(["bash", script, "--repo", target.path], { env: { MATTSTACK_HOME: mattstackHome }, timeoutMs: MATERIALIZE_TIMEOUT_MS });
    repos.push(
      res.code === 0
        ? { name: target.name, path: target.path, ok: true, detail: res.stdout.trim() || "materialized" }
        // A non-git-remote repo (exit 2) or any other script failure is reported per-repo, not fatal to the batch.
        : { name: target.name, path: target.path, ok: false, detail: res.stderr.trim() || `merge-manifests.sh exited ${res.code}` },
    );
  }

  return { skipped: false, repos };
}
