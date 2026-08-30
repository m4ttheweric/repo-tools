/** Short request id for tying a daemon log line to the invocation. */
export function shortReqId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

interface SuppressEntry { lastEmitAt: number; suppressed: number }

/** Per-(cmd,error) suppression: always emit the first occurrence and, once per
 *  window, emit again carrying the count suppressed since the last emit. */
export function makeSuppressor(windowMs: number) {
  const map = new Map<string, SuppressEntry>();
  return {
    check(key: string, now: number): { emit: boolean; suppressed: number } {
      const e = map.get(key);
      if (!e) {
        map.set(key, { lastEmitAt: now, suppressed: 0 });
        return { emit: true, suppressed: 0 };
      }
      if (now - e.lastEmitAt >= windowMs) {
        const suppressed = e.suppressed;
        e.lastEmitAt = now;
        e.suppressed = 0;
        return { emit: true, suppressed };
      }
      e.suppressed += 1;
      return { emit: false, suppressed: e.suppressed };
    },
  };
}
