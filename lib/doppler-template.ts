/**
 * Per-repo Doppler template — the source of truth for which app subdir of a
 * worktree maps to which Doppler project + config.
 *
 * Resolved through the settings resolver (`rt.dopplerTemplate`, team.repo
 * scope): a flat array of objects:
 *   - { path: apps/backend,  project: backend,  config: dev }
 *   - { path: apps/frontend, project: frontend, config: dev }
 *
 * The reconciler reads this and writes corresponding entries to
 * ~/.doppler/.doppler.yaml so Doppler CLI works in any worktree without
 * `make initDoppler`. See docs/superpowers/specs/2026-04-30-doppler-template-sync-design.md.
 *
 * loadTemplate takes the already-resolved setting value rather than
 * resolving it itself — the caller (reconcileForRepo) is the one place that
 * calls getSetting("rt.dopplerTemplate"), once per repo per tick.
 */

export interface DopplerTemplateEntry {
  /** Path relative to the worktree root (e.g. "apps/backend"). */
  path: string;
  /** Doppler project name. */
  project: string;
  /** Doppler config name (almost always "dev"). */
  config: string;
}

/**
 * Parses an already-resolved `rt.dopplerTemplate` value into entries, or
 * `null` when nothing was declared or the value isn't a template-shaped
 * array — the same "opt out" answer a missing or malformed file gave before.
 */
export function loadTemplate(raw: unknown): DopplerTemplateEntry[] | null {
  if (raw === undefined || !Array.isArray(raw)) return null;

  const entries: DopplerTemplateEntry[] = [];
  for (const item of raw) {
    if (
      item && typeof item === "object" &&
      typeof item.path    === "string" &&
      typeof item.project === "string" &&
      typeof item.config  === "string"
    ) {
      entries.push({ path: item.path, project: item.project, config: item.config });
    }
  }
  return entries;
}
