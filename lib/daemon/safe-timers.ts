/**
 * lib/daemon/safe-timers.ts — try/catch-wrapped setInterval/setTimeout.
 *
 * A bare `setInterval`/`setTimeout` callback that throws synchronously
 * (e.g. a sqlite SQLITE_FULL on a WAL write) becomes an uncaughtException
 * with no stack frame back to the timer that scheduled it — Node/Bun's
 * event loop has nothing to attribute the throw to but the process itself,
 * so installCrashHandlers treats it as fatal and exits the daemon. Wrapping
 * the tick converts that crash into a logged warning.
 */

import type { Logger } from "pino";

export function safeInterval(
  fn: () => void,
  ms: number,
  label: string,
  log: Logger,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      fn();
    } catch (err) {
      log.warn({ err, label }, "timer tick failed");
    }
  }, ms);
}

export function safeTimeout(
  fn: () => void,
  ms: number,
  label: string,
  log: Logger,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    try {
      fn();
    } catch (err) {
      log.warn({ err, label }, "timer tick failed");
    }
  }, ms);
}
