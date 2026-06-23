import { useCallback, useEffect, useState } from "react";
import { fetchProcesses } from "../lib/api.ts";
import { applyProcessChanged } from "../lib/processes.ts";
import type { ProcessChangedEvent, ProcessRecord } from "../lib/types.ts";

/**
 * Loads the process list and keeps it live via the daemon's `process:changed`
 * WebSocket. Unknown ids (a brand-new process) trigger a full refetch, since
 * the event alone lacks cmd/cwd/repo.
 */
export function useProcesses() {
  const [processes, setProcesses] = useState<ProcessRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProcesses(await fetchProcesses());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type !== "process:changed") return;
        const ev = msg.data as ProcessChangedEvent;
        setProcesses((cur) => {
          if (!cur.some((p) => p.id === ev.id)) {
            void refresh();
            return cur;
          }
          return applyProcessChanged(cur, ev);
        });
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => ws.close();
  }, [refresh]);

  return { processes, connected, error, refresh };
}
