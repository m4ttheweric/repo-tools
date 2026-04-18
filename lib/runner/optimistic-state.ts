/**
 * Optimistic-state merge for the runner UI.
 *
 * `pollDaemon()` fetches authoritative process state from the daemon every
 * 2 seconds. But when the user starts or stops a process, the UI optimistically
 * sets "starting"/"stopping" states immediately so the user sees instant visual
 * feedback. The daemon also sets these transient states authoritatively, but
 * the transition window is often too brief (e.g. a fast SIGTERM kill completes
 * in <100ms) for the 2s poll to catch. Without a minimum display window, the
 * spinner would flicker invisibly between polls.
 *
 * This pure function merges daemon-reported truth with in-flight client-side
 * transients. A transient is kept when EITHER the daemon hasn't yet reached
 * the expected terminal state (meaning the transient is still semantically
 * accurate) OR the optimistic state is still within its minimum display window.
 * Otherwise the transient is dropped and daemon truth is accepted.
 *
 * The function is pure — it does NOT mutate the caller's `optimisticSetAt`
 * map. Instead, it returns `expiredIds`: the ids whose optimistic bookkeeping
 * the caller should delete after applying the merge.
 */

import type { EntryState } from "../../commands/runner.tsx";

/** Default minimum display window for optimistic "starting"/"stopping". */
export const DEFAULT_MIN_TRANSIENT_MS = 800;

export interface MergeOptimisticInput {
  /** Fresh states reported by the daemon (truth). */
  daemonStates: Map<string, EntryState>;
  /** Current UI states (may contain in-flight optimistic transients). */
  currentStates: Map<string, EntryState>;
  /** Timestamp (ms) when each optimistic transient was first set. */
  optimisticSetAt: Map<string, number>;
  /** Current time (ms). Usually `Date.now()`. */
  now: number;
  /** Minimum display time (ms) for optimistic transients. */
  minTransientMs?: number;
}

export interface MergeOptimisticResult {
  /** Merged states — daemon truth, with still-valid optimistic transients preserved. */
  merged: Map<string, EntryState>;
  /**
   * Ids whose optimistic bookkeeping (`optimisticSetAt`) the caller should delete.
   * These are transients that have both (a) aged past the minimum display window
   * AND (b) been confirmed reached-terminal-state by the daemon.
   */
  expiredIds: string[];
}

/**
 * Merge daemon-reported state with in-flight optimistic transients.
 *
 * See module docstring for semantics. Pure function — caller is responsible
 * for deleting `expiredIds` entries from its own `optimisticSetAt` map.
 */
export function mergeOptimisticStates(
  input: MergeOptimisticInput,
): MergeOptimisticResult {
  const {
    daemonStates,
    currentStates,
    optimisticSetAt,
    now,
    minTransientMs = DEFAULT_MIN_TRANSIENT_MS,
  } = input;

  const merged = new Map(daemonStates);
  const expiredIds: string[] = [];

  for (const [id, current] of currentStates) {
    if (current === "stopping") {
      const fresh = daemonStates.get(id) ?? "stopped";
      const age = now - (optimisticSetAt.get(id) ?? 0);
      if (fresh !== "stopped" && fresh !== "crashed" || age < minTransientMs) {
        merged.set(id, "stopping");
      } else {
        expiredIds.push(id);
      }
    } else if (current === "starting") {
      const fresh = daemonStates.get(id);
      const age = now - (optimisticSetAt.get(id) ?? 0);
      if (fresh !== "running" && fresh !== "crashed" || age < minTransientMs) {
        merged.set(id, "starting");
      } else {
        expiredIds.push(id);
      }
    }
  }

  return { merged, expiredIds };
}
