/**
 * Runs the mattstack plugin's merge-manifests.sh against every registered
 * repo, materializing that repo's skills.jsonc binding manifest.
 *
 * Idempotent and re-callable: the apply engine's skills.materialize step
 * runs before plugins.install (script not installed yet, so it skips
 * honestly), and plugins.install calls materializeSkills again once the
 * plugin is on disk — this module exposes no state of its own, so a repeat
 * call just reruns the script.
 */

import { join } from "path";
import { getKnownRepos } from "../repo-index.ts";
import { UserActionableError } from "./errors.ts";
import type { Probes } from "./probes.ts";

const CACHE_DIR_SEGMENTS = ["plugins", "cache", "mattstack", "mattstack"];
const SCRIPT_SEGMENTS = ["plugin", "skills", "parameterized-skills", "scripts", "merge-manifests.sh"];

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

export async function materializeSkills(p: Probes, opts: { repo?: string }): Promise<{ repos: MaterializeRepoResult[] }> {
  const script = findMergeManifests(p);
  if (!script) {
    throw new UserActionableError("merge-manifests-missing", "install the mattstack plugin first (plugins.install)");
  }

  const known = getKnownRepos();
  let targets: { name: string; path: string }[];
  if (opts.repo) {
    const match = known.find((r) => r.repoName === opts.repo);
    if (!match) {
      throw new UserActionableError("repo-not-registered", `"${opts.repo}" is not a registered repo (rt repos register first)`);
    }
    targets = [{ name: match.repoName, path: match.worktrees[0]!.path }];
  } else {
    targets = known.map((r) => ({ name: r.repoName, path: r.worktrees[0]!.path }));
  }

  const mattstackHome = join(p.home, ".mattstack");
  const repos: MaterializeRepoResult[] = [];

  for (const target of targets) {
    const res = await p.exec(["bash", script, "--repo", target.path], { env: { MATTSTACK_HOME: mattstackHome } });
    repos.push(
      res.code === 0
        ? { name: target.name, path: target.path, ok: true, detail: res.stdout.trim() || "materialized" }
        // A non-git-remote repo (exit 2) or any other script failure is reported per-repo, not fatal to the batch.
        : { name: target.name, path: target.path, ok: false, detail: res.stderr.trim() || `merge-manifests.sh exited ${res.code}` },
    );
  }

  return { repos };
}
