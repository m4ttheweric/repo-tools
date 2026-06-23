/**
 * openLogStream — read-only log tail for an external consumer (GUI log panel).
 *
 * Replays the buffered history once, then forwards live PTY output chunks as
 * text. Returns an unsubscribe to detach the live subscription. This is the
 * browser-WS analogue of the attach socket, minus the keystroke (input) path.
 *
 * Dependencies are injected (replay source, live subscribe, send) so the core
 * is unit-testable without a WebSocket server or a live process.
 */

export interface LogStreamDeps {
  getReplay: (id: string) => string[];
  subscribe: (id: string, cb: (chunk: Uint8Array) => void) => () => void;
  send: (data: string) => void;
}

export function openLogStream(id: string, deps: LogStreamDeps): () => void {
  const replay = deps.getReplay(id);
  if (replay.length > 0) deps.send(replay.join("\n") + "\n");
  const decoder = new TextDecoder();
  return deps.subscribe(id, (chunk) => deps.send(decoder.decode(chunk)));
}

const MAX_DIM = 1000;

export interface LogStreamControlDeps {
  /** Resize the underlying PTY to match the viewer's terminal grid. */
  resize: (cols: number, rows: number) => void;
}

/**
 * Handle an inbound control message on a log socket. The only control a
 * read-only viewer may send is a resize: the browser terminal reports its
 * fitted column/row count so the PTY matches and TUIs stop wrapping. Anything
 * malformed or out of range is silently ignored — a viewer must never be able
 * to wedge the daemon with a bad frame.
 */
export function handleLogStreamControl(
  raw: string | Uint8Array,
  deps: LogStreamControlDeps,
): void {
  let msg: unknown;
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    msg = JSON.parse(text);
  } catch {
    return; // not JSON — ignore
  }
  if (typeof msg !== "object" || msg === null) return;
  const m = msg as { type?: unknown; cols?: unknown; rows?: unknown };
  if (m.type !== "resize") return;
  if (!Number.isInteger(m.cols) || !Number.isInteger(m.rows)) return;
  const cols = m.cols as number;
  const rows = m.rows as number;
  if (cols < 1 || rows < 1) return;
  deps.resize(Math.min(cols, MAX_DIM), Math.min(rows, MAX_DIM));
}

export interface AttachMessageDeps {
  /** Resize the underlying PTY to match the viewer's terminal grid. */
  resize: (cols: number, rows: number) => void;
  /** Write raw keystrokes to the underlying PTY (terminal.write). */
  input: (data: Uint8Array) => void;
}

/**
 * Handle an inbound message on an interactive attach socket. The transport
 * disambiguates by frame type, so there's no fragile "does it start with {"
 * heuristic: string frames are JSON control (currently only resize); binary
 * frames are raw keystrokes written straight to the PTY. This keeps a user who
 * literally types `{"type":"resize"...}` from being misread as a control
 * message — input is always input.
 */
export function handleAttachMessage(
  raw: string | ArrayBuffer | Uint8Array,
  deps: AttachMessageDeps,
): void {
  if (typeof raw === "string") {
    handleLogStreamControl(raw, { resize: deps.resize });
    return;
  }
  deps.input(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
}
