import { useEffect, useState } from "react";
import { StatusBadge } from "./StatusBadge.tsx";
import { Button } from "@/components/ui/button";
import { LogPanel } from "./LogPanel.tsx";
import { controlProcess, type ControlAction } from "../lib/api.ts";
import { uptime } from "../lib/format.ts";
import type { ProcessRecord } from "../lib/types.ts";

const LIVE = new Set(["running", "warm", "starting"]);
const DEAD = new Set(["stopped", "crashed"]);

export function ProcessRow({ p, now }: { p: ProcessRecord; now: number }) {
  const [busy, setBusy] = useState(false);
  // Auto-open output for a crashed process so the failure reason is visible.
  const [showLogs, setShowLogs] = useState(p.state === "crashed");

  useEffect(() => {
    if (p.state === "crashed") setShowLogs(true);
  }, [p.state]);

  const run = async (action: ControlAction) => {
    setBusy(true);
    try {
      await controlProcess(p.id, action);
    } catch (e) {
      alert(`${action} failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="w-24 shrink-0">
          <StatusBadge state={p.state} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-foreground">{p.id}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={p.cmd}>{p.cmd}</div>
          {p.url && (
            <a href={p.url} target="_blank" rel="noreferrer" className="truncate font-mono text-[11px] text-sel-blue hover:underline">{p.url}</a>
          )}
        </div>
        <div className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {p.state === "running" && p.startedAt ? uptime(p.startedAt, now) : ""}
          {p.state === "crashed" && p.exitCode != null ? `exit ${p.exitCode}` : ""}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="xs" variant="ghost" onClick={() => setShowLogs((s) => !s)}>
            {showLogs ? "Hide logs" : "Logs"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => run("start")} disabled={busy || !DEAD.has(p.state)}>Start</Button>
          <Button size="xs" variant="outline" onClick={() => run("restart")} disabled={busy || p.state === "stopping"}>Restart</Button>
          <Button size="xs" variant="destructive" onClick={() => run("stop")} disabled={busy || !LIVE.has(p.state)}>Stop</Button>
        </div>
      </div>
      {showLogs && <LogPanel id={p.id} />}
    </div>
  );
}
