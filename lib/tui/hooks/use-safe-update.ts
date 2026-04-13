/**
 * UTILITY: createSafeUpdater (Rezi dashboards)
 *
 * Guards app.update() from throwing ZRUI_INVALID_STATE when called on a
 * Rezi app that hasn't started yet or has already been disposed.
 *
 * This happens when async callbacks (pollDaemon, timers, fs.watch) race with
 * app startup or shutdown.
 *
 * Source: commands/runner.tsx safeUpdate pattern (lines 1341-1352)
 *
 * Usage:
 *   let appRunning = true;
 *   const safeUpdate = createSafeUpdater(() => appRunning);
 *   // ...
 *   appRunning = false; // on app stop
 */

/**
 * Creates a guarded update function for a Rezi app.
 *
 * @param isRunning - Getter function that returns true while the app is active.
 *                   Typically a closure over a `let appRunning = true` flag.
 * @returns A wrapper around app.update() that silently no-ops when the app is
 *          not running or throws ZRUI_INVALID_STATE.
 *
 * @example
 * ```typescript
 * let appRunning = true;
 * const safeUpdate = createSafeUpdater(() => appRunning);
 *
 * // In async callbacks:
 * safeUpdate((s) => ({ ...s, lanes: newLanes }));
 *
 * // On app stop:
 * appRunning = false;
 * ```
 */
export function createSafeUpdater<S>(
  isRunning: () => boolean,
  update: (updater: (s: S) => S) => void,
): (updater: (s: S) => S) => void {
  return (updater) => {
    if (!isRunning()) return;
    try {
      update(updater);
    } catch {
      // app not ready or already disposed — silently ignore
    }
  };
}
