/**
 * The pull cadence for a team clone, shared by the supervisor that schedules
 * it and the checklist row that judges staleness against it. A leaf module on
 * purpose: the row runs inside `rt verify`, which must not pull the daemon
 * engine in behind it.
 */

/** Registry default for `rt.teamSnapshot.pullIntervalSec`, and the fallback a non-numeric setting degrades to, so a corrupt value lands on what a fresh machine starts with. */
export const PULL_INTERVAL_FALLBACK_SEC = 300;

/**
 * `rt.teamSnapshot` is hand-editable jsonc with no per-field validation, so
 * `pullIntervalSec` can arrive as a string, null, zero or a negative number,
 * and `Math.max(30, NaN)` is NaN. A NaN delay makes `setTimeout` fire
 * immediately and both the rescan and the engine's `.finally(schedulePull)`
 * re-arm themselves, so a non-numeric interval would become a hot `git fetch`
 * loop rather than a slow one; a zero would make every clone read as stale the
 * moment it was pulled.
 */
export function clampPullIntervalSec(value: number): number {
  return Number.isFinite(value) ? Math.max(30, value) : PULL_INTERVAL_FALLBACK_SEC;
}
