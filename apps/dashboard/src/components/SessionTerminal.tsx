import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { XTERM_SELENIZED_DARK as THEME } from "./xterm-theme.ts";

/**
 * Interactive terminal for any daemon session over /ws/processes/:id/attach.
 * Output → xterm; keystrokes → PTY as binary frames; resize → JSON control
 * frame. Unmounting only detaches (the session keeps running); reattaching
 * replays scrollback. Lifecycle controls live in SessionControlBar.
 */
export function SessionTerminal({ id }: { id: string }) {
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
    const ws = new WebSocket(`${proto}://${location.host}/ws/processes/${encodeURIComponent(id)}/attach`);
    ws.binaryType = "arraybuffer";

    const encoder = new TextEncoder();
    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(d));
    });

    const onResize = () => {
      try { fit.fit(); sendResize(); } catch { /* detached mid-resize */ }
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    ws.onopen = () => { setConnected(true); sendResize(); };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      if (typeof e.data === "string") term.write(e.data);
      else if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
    };

    return () => { onData.dispose(); ws.close(); ro.disconnect(); term.dispose(); };
  }, [id]);

  return (
    <div style={{ backgroundColor: THEME.background }}>
      {!connected && <div className="px-3 pt-1 text-[11px] text-[#72898f]">connecting…</div>}
      <div ref={hostRef} className="h-96 px-2 pb-2" />
    </div>
  );
}
