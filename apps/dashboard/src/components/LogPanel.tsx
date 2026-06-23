import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { XTERM_SELENIZED_DARK as THEME } from "./xterm-theme.ts";

/**
 * Live (and post-crash) output for one process, rendered through a real
 * terminal emulator. Many dev processes are self-repainting TUIs (turbo,
 * `start:lite`) that move the cursor up and erase lines to redraw a status
 * block in place — xterm.js maintains a screen grid and honors those control
 * sequences, so a TUI shows as one updating panel instead of an ever-growing
 * pile of frames. The daemon replays the recent buffer first, so a crashed
 * process still shows the output that explains why it died.
 */
export function LogPanel({ id }: { id: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: THEME,
      cursorBlink: false,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/processes/${encodeURIComponent(id)}/logs`,
    );
    ws.binaryType = "arraybuffer";

    // Tell the daemon to size the PTY to our terminal grid, so a TUI's in-place
    // redraws line up instead of wrapping. Sent on connect and on every refit.
    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

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
      ws.close();
      ro.disconnect();
      term.dispose();
    };
  }, [id]);

  return (
    // The terminal is Selenized dark; the padding frame matches its background
    // so the dark surface reads as one panel inside the light app.
    <div className="border-t border-border px-2 py-2" style={{ backgroundColor: THEME.background }}>
      <div ref={hostRef} className="h-80" />
      {!connected && <div className="px-2 pt-1 text-[11px] text-[#72898f]">connecting…</div>}
    </div>
  );
}
