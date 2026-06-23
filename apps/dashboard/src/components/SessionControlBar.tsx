import { useState } from "react";
import { Button } from "@/components/ui/button";
import { controlProcess, type ControlAction } from "../lib/api.ts";
import { uptime } from "../lib/format.ts";
import { isLive, type Session } from "../lib/sessions.ts";

/**
 * Control strip above the active session's terminal. Command sessions get
 * Start/Restart/Stop + meta (state, cmd, portless URL); shell sessions show meta
 * only (they're closed via the tab's ✕). Rendered inside the card's `.dark`
 * console region, so it uses dark tokens.
 */
export function SessionControlBar({
  session,
  now,
  onChanged,
}: {
  session: Session;
  now: number;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const live = isLive(session.state);

  const run = async (action: ControlAction) => {
    setBusy(true);
    try {
      await controlProcess(session.id, action);
      onChanged();
    } catch (e) {
      alert(`${action} failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px]">
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
        <span className="text-foreground">{session.label}</span>
        {" · "}
        {session.state === "running" && session.startedAt ? uptime(session.startedAt, now) : session.state}
        {session.state === "crashed" && session.exitCode != null ? ` (exit ${session.exitCode})` : ""}
        {" · "}{session.cmd}
        {session.url && (
          <>
            {" · "}
            <a href={session.url} target="_blank" rel="noreferrer" className="text-sel-blue hover:underline">
              {session.url}
            </a>
          </>
        )}
      </span>
      {session.kind === "command" && (
        <span className="flex shrink-0 gap-1.5">
          {!live && <Button size="xs" variant="secondary" disabled={busy} onClick={() => run("start")}>Start</Button>}
          {live && <Button size="xs" variant="secondary" disabled={busy || session.state === "stopping"} onClick={() => run("restart")}>Restart</Button>}
          {live && <Button size="xs" variant="destructive" disabled={busy} onClick={() => run("stop")}>Stop</Button>}
        </span>
      )}
    </div>
  );
}
