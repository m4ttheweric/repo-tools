/**
 * Doppler-sync reconciler — keeps `~/.doppler/.doppler.yaml` consistent with
 * each repo's `rt.dopplerTemplate` setting across all worktrees.
 *
 * Called once per cache-refresh tick by the daemon (`refreshCacheImpl` in
 * `lib/daemon.ts`) and once when a new worktree is created (`lib/worktree/create.ts`).
 * The reconciler is additive — it only writes missing entries and never
 * overwrites existing ones, so user overrides via `doppler setup -p X -c Y`
 * are preserved.
 */

import { join } from "path";
import { loadTemplate } from "../doppler-template.ts";
import { getSetting } from "../settings/resolve.ts";
import { loadDopplerConfig, writeDopplerConfig, addScopedEntry } from "../doppler-config.ts";

export interface ReconcileSummary {
  wrote:      number;
  overridden: number;
  unchanged:  number;
  /** Why the repo was skipped, if any. Absent when the reconciler ran normally. */
  skipped?:   "no-template" | "malformed-template";
}

export interface ReconcileOpts {
  repoIdentity:  string | null;
  worktreeRoots: string[];
}

export async function reconcileForRepo(opts: ReconcileOpts): Promise<ReconcileSummary> {
  // Distinguish "no template declared" (silent opt-out) from "declared but
  // unusable" (error) — a presence check on the raw resolved value, not
  // explainSetting, so an authored-but-empty array still counts as declared.
  // A resolver throw (e.g. an unexpandable ${...} variable authored by hand)
  // counts as "declared but unusable", not "nothing declared" — this runs
  // once per repo per cache-refresh tick and must never take the cycle down.
  let value: unknown;
  try {
    value = getSetting<unknown>("rt.dopplerTemplate", { repoIdentity: opts.repoIdentity }).value;
  } catch {
    return { wrote: 0, overridden: 0, unchanged: 0, skipped: "malformed-template" };
  }
  if (value === undefined) {
    return { wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" };
  }
  const template = loadTemplate(value);
  if (template === null) {
    return { wrote: 0, overridden: 0, unchanged: 0, skipped: "malformed-template" };
  }
  if (template.length === 0) {
    return { wrote: 0, overridden: 0, unchanged: 0 };
  }

  const dopplerCfg = loadDopplerConfig();

  let wrote = 0, overridden = 0, unchanged = 0;
  for (const root of opts.worktreeRoots) {
    for (const entry of template) {
      const absPath = join(root, entry.path);
      const result = addScopedEntry(dopplerCfg, absPath, entry.project, entry.config);
      if (result === "wrote")           wrote++;
      else if (result === "unchanged")  unchanged++;
      else if (result === "overridden") overridden++;
    }
  }

  if (wrote > 0) {
    writeDopplerConfig(dopplerCfg);
  }

  return { wrote, overridden, unchanged };
}
