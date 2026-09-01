/**
 * Where a pre-cutover rt left this repo's per-repo files.
 *
 * Leaf module on purpose: its three consumers (run-history, endpoint store,
 * worktree registry) sit BELOW lib/repo-index.ts in the import graph (that
 * module imports worktree/registry.ts), so the index namespace is mirrored
 * here rather than imported, the same trade repo-index.ts already makes in the
 * other direction for the worktree-registry namespace.
 */

import { existsSync } from "fs";
import { join } from "path";
import { repoDataDir } from "./rt-paths.ts";
import { repoLabel } from "./repo-label.ts";
import { listKvValues } from "./state/index.ts";

/** Mirrors lib/repo-index.ts's REPO_INDEX_NS. See this module's header. */
const REPO_INDEX_NS = "repo-index";

/**
 * The path a one-shot legacy import should probe for `file`.
 *
 * Before the identity cutover the data dir was keyed by the DISPLAY name that
 * `repoLabel` decodes back out of the wire, so an importer probing only
 * `repoDataDir(identity)` never finds those files and they sit on disk
 * unreachable. The identity dir still wins whenever it holds the file; the
 * legacy dir is a fallback, and only when the label belongs to this repo
 * alone. Two registered repos can decode to one label (`m4ttheweric/skills`
 * and `m4ttstack/skills` are both "skills"), and adopting a shared directory
 * would hand one repo's history to the other.
 *
 * Always returns a path, so callers keep their existing "does it exist?"
 * check as the only gate.
 */
export function legacyRepoFile(identity: string, file: string): string {
  const current = join(repoDataDir(identity), file);
  if (existsSync(current)) return current;

  const label = repoLabel(identity);
  if (label === identity) return current; // not a wire: its own dir is the only one

  const legacy = join(repoDataDir(label), file);
  if (!existsSync(legacy)) return current;

  let claimants: string[];
  try {
    claimants = Object.keys(listKvValues<string>(REPO_INDEX_NS)).filter(k => repoLabel(k) === label);
  } catch {
    return current; // unreadable index: never guess at an owner
  }
  return claimants.length === 1 ? legacy : current;
}
