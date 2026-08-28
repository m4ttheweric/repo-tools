/**
 * "A consumer is watching" signal for the background scans. The tray/CLI/console
 * calling ports/system-processes/tray:status stamps demand here (via the
 * command-router wrapper); pollers skip the 10s/30s scans when nothing has asked
 * recently, so an idle machine stops paying the lsof/git tax (S058, S093).
 */
let lastDemandAt = 0;

export function recordDemand(): void {
  lastDemandAt = Date.now();
}

/** True when a consumer read a scan-backed command within `ms`. */
export function demandedWithin(ms: number): boolean {
  return lastDemandAt !== 0 && Date.now() - lastDemandAt < ms;
}

/** Wrap the named handler entries so each call stamps demand, then delegates. */
export function wrapWithDemand<T extends Record<string, any>>(handlers: T, cmds: string[]): T {
  for (const cmd of cmds) {
    const inner = handlers[cmd];
    if (typeof inner !== "function") continue;
    (handlers as any)[cmd] = (...args: any[]) => { recordDemand(); return inner(...args); };
  }
  return handlers;
}
