/**
 * wireProcessEvents — bridge StateStore transitions onto the daemon's WS
 * broadcast so external consumers (GUI) get live `process:changed` events
 * instead of polling `process:states`.
 *
 * Dependencies are injected (state-change subscription, pid/exitCode lookups,
 * broadcast) so the wiring is unit-testable without a live daemon.
 *
 * Event payload: { id, from, to, pid?, exitCode? }
 *   - pid is present while the process is live (cleared on terminal states)
 *   - exitCode is present after the process exits
 * The broadcast layer stamps its own timestamp.
 */

import type { ProcessState } from "./state-store.ts";

export interface ProcessEventDeps {
  onStateChange: (cb: (id: string, prev: ProcessState, next: ProcessState) => void) => void;
  pidOf: (id: string) => number | undefined;
  exitCodeOf: (id: string) => number | undefined;
  broadcast: (type: string, data: any) => void;
}

export function wireProcessEvents(deps: ProcessEventDeps): void {
  deps.onStateChange((id, prev, next) => {
    deps.broadcast("process:changed", {
      id,
      from: prev,
      to: next,
      pid: deps.pidOf(id),
      exitCode: deps.exitCodeOf(id),
    });
  });
}
