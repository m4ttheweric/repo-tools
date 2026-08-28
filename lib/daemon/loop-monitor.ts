/**
 * Event-loop drift monitor. A ~250ms unref'd interval measures how late each
 * tick fires vs its scheduled time; a large drift means the loop was blocked.
 * The interval callback is created once and the stats object is preallocated,
 * so the hot tick allocates nothing. Every ~2s it also invokes an
 * `onHeartbeat` callback (the daemon writes the heartbeat file from that).
 */
import type { Logger } from "pino";

export interface LoopStats {
  lagMs: number;
  maxLagMs: number;
  maxLagAt: number;
  stalls: number;
  lastStallAt: number | null;
  lastStallCmd: string | null;
  currentlyStalled: boolean;
}

export function newLoopStats(): LoopStats {
  return { lagMs: 0, maxLagMs: 0, maxLagAt: 0, stalls: 0, lastStallAt: null, lastStallCmd: null, currentlyStalled: false };
}

interface TickOpts {
  stallLogMs: number;
  stallUnhealthyMs: number;
  stallRecentMs: number;
  maxLagWindowMs?: number;
}

/** Pure: fold one tick into `stats`. `onStall` fires once per stall (warn sink). */
export function applyTick(
  stats: LoopStats,
  expected: number,
  now: number,
  currentCmd: string | null,
  opts: TickOpts,
  onStall: (drift: number, cmd: string | null) => void,
): void {
  const drift = now - expected;
  stats.lagMs = drift > 0 ? drift : 0;
  const maxLagWindowMs = opts.maxLagWindowMs ?? opts.stallRecentMs;
  if (stats.lagMs > stats.maxLagMs || now - stats.maxLagAt > maxLagWindowMs) {
    stats.maxLagMs = stats.lagMs;
    stats.maxLagAt = now;
  }
  if (drift > opts.stallLogMs) {
    stats.stalls += 1;
    stats.lastStallAt = now;
    stats.lastStallCmd = currentCmd;
    onStall(drift, currentCmd);
  }
  stats.currentlyStalled =
    stats.lastStallAt !== null &&
    now - stats.lastStallAt <= opts.stallRecentMs &&
    drift > opts.stallUnhealthyMs;
}

export interface LoopMonitorOpts {
  log: Logger;
  tickMs?: number;
  stallLogMs?: number;
  stallUnhealthyMs?: number;
  stallRecentMs?: number;
  maxLagWindowMs?: number;
  heartbeatMs?: number;
  currentCmd: () => string | null;
  onHeartbeat: (at: number, seq: number) => void;
}

export function startLoopMonitor(
  opts: LoopMonitorOpts,
): { stats: LoopStats; seq: () => number; stop: () => void } {
  const tickMs = opts.tickMs ?? 250;
  const tickOpts: TickOpts = {
    stallLogMs: opts.stallLogMs ?? 1000,
    stallUnhealthyMs: opts.stallUnhealthyMs ?? 2000,
    stallRecentMs: opts.stallRecentMs ?? 10_000,
    maxLagWindowMs: opts.maxLagWindowMs ?? (opts.stallRecentMs ?? 10_000),
  };
  const heartbeatMs = opts.heartbeatMs ?? 2000;
  const stats = newLoopStats();
  let expected = Date.now() + tickMs;
  let lastHeartbeat = 0;
  let seq = 0;
  let warnedThisStall = false;

  // Hoisted once so the hot tick allocates nothing: it must not build a
  // fresh closure every 250ms. onStall closes over warnedThisStall by reference.
  const onStall = (drift: number, cmd: string | null): void => {
    if (!warnedThisStall) {
      opts.log.warn({ driftMs: drift, cmd }, "event loop stalled");
      warnedThisStall = true;
    }
  };

  const timer = setInterval(() => {
    const now = Date.now();
    applyTick(stats, expected, now, opts.currentCmd(), tickOpts, onStall);
    if (stats.lagMs <= tickOpts.stallLogMs) warnedThisStall = false;
    expected = now + tickMs;
    if (now - lastHeartbeat >= heartbeatMs) {
      lastHeartbeat = now;
      opts.onHeartbeat(now, ++seq);
    }
  }, tickMs);
  timer.unref();

  return { stats, seq: () => seq, stop: () => clearInterval(timer) };
}
