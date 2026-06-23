import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { controlProcess } from "../lib/api.ts";
import { XTERM_SELENIZED_DARK as THEME } from "./xterm-theme.ts";

/**
 * An interactive in-browser terminal attached to a daemon-managed shell session.
 * Bidirectional over /ws/processes/:id/attach: PTY output → xterm, keystrokes
 * (xterm onData) → PTY as binary frames, resize as a JSON control frame. Closing
 * the panel only detaches — the shell keeps running, so reopening replays its
 * scrollback. "Kill" stops the session for good.
 */
export function TerminalSession({ id, onKilled }: { id: string; onKilled?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10000,
      theme: THEME,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/processes/${encodeURIComponent(id)}/attach`,
    );
    ws.binaryType = "arraybuffer";

    const encoder = new TextEncoder();
    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    // Keystrokes → PTY. Binary frame so the daemon treats it as raw input, never
    // as a control message (a typed `{` must reach the shell, not be parsed).
    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d));
    });

    const onResize = () => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* host detached mid-resize */
      }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    ws.onopen = () => {
      setConnected(true);
      sendResize();
    };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      if (typeof e.data === "string") term.write(e.data);
      else if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
    };

    return () => {
      onData.dispose();
      ws.close();
      ro.disconnect();
      term.dispose();
    };
  }, [id]);

  const kill = async () => {
    try {
      await controlProcess(id, "stop");
      onKilled?.();
    } catch (e) {
      alert(`kill failed: ${e}`);
    }
  };

  return (
    <div className="border-t border-border" style={{ backgroundColor: THEME.background }}>
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="font-mono text-[11px] text-[#72898f]">
          {id}
          {!connected && " · connecting…"}
        </span>
        <Button size="xs" variant="ghost" onClick={kill} className="text-[#fa5750] hover:text-[#ff665c]">
          Kill
        </Button>
      </div>
      <div ref={hostRef} className="h-96 px-2 pb-2" />
    </div>
  );
}
