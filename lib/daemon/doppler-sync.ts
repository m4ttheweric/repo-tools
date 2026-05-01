/**
 * Doppler-sync reconciler — keeps `~/.doppler/.doppler.yaml` consistent with
 * each repo's `~/.rt/<repo>/doppler-template.yaml` across all worktrees.
 *
 * Called once per cache-refresh tick by the daemon (`refreshCacheImpl` in
 * `lib/daemon.ts`) and on demand by `rt doppler sync`. The reconciler is
 * additive — it only writes missing entries and never overwrites existing
 * ones, so user overrides via `doppler setup -p X -c Y` are preserved.
 */

import { existsSync } from "fs";
import { join } from "path";
import { loadTemplate, templatePath } from "../doppler-template.ts";
import { loadDopplerConfig, writeDopplerConfig, addScopedEntry } from "../doppler-config.ts";

export interface ReconcileSummary {
  wrote:      number;
  overridden: number;
  unchanged:  number;
  /** Why the repo was skipped, if any. Absent when the reconciler ran normally. */
  skipped?:   "no-template" | "malformed-template";
}

export interface ReconcileOpts {
  repoName:      string;
  worktreeRoots: string[];
}

export async function reconcileForRepo(opts: ReconcileOpts): Promise<ReconcileSummary> {
  // Distinguish "no template" (silent opt-out) from "malformed template" (error).
  const path = templatePath(opts.repoName);
  if (!existsSync(path)) {
    return { wrote: 0, overridden: 0, unchanged: 0, skipped: "no-template" };
  }
  const template = loadTemplate(opts.repoName);
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
