const DEFAULT_TIMEOUT_MS = 1000;

export async function deliverToInbox(
  socketPath: string,
  content: string,
  opts?: { timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const frame = {
    msgV: 1,
    msg_id: crypto.randomUUID(),
    type: "user",
    message: { role: "user", content },
    priority: "next",
  };
  const line = JSON.stringify(frame) + "\n";

  // Shared across both racers so a late connect (after the timeout already
  // told the caller ok:false) closes without writing, instead of delivering
  // a frame the caller believes never went out.
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          if (settled) {
            socket.end();
            return;
          }
          settled = true;
          clearTimeout(timer);
          socket.write(line);
          socket.end();
          resolve({ ok: true });
        },
        data() {},
        error(_socket, error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: error.message });
        },
      },
    }).catch((error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });

  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);
  });

  return Promise.race([attempt, timeout]);
}

export function renderDeliveries(
  items: Array<{ room: string; dm: boolean; handle: string; body: string }>,
): string {
  return items
    .map((item) => `${item.dm ? "[dm]" : `[#${item.room}]`} ${item.handle}: ${item.body}`)
    .join("\n");
}

/**
 * Claude Code's terminal renders an inbound peer message collapsed (one
 * labeled row, body hidden until expanded) ONLY when the content opens with
 * its `<cross-session-message ...>` envelope; bare text renders in full.
 * `from-name` is the collapsed row's label. No `from` attribute: that is a
 * SendMessage reply address, and rt recipients reply via `rt chat post/dm`
 * (taught in the body), so advertising an unreachable address would misteach
 * the reply path. The envelope changes presentation only -- the model always
 * receives the full body.
 */
export function wrapCrossSession(label: string, body: string): string {
  const safe = label.replace(/["<>]/g, "'");
  return `<cross-session-message from-name="${safe}">\n${body}\n</cross-session-message>`;
}

/** The collapsed row's label: the sender for a single message, a count for a batched catch-up. */
export function deliveryLabel(
  items: Array<{ room: string; dm: boolean; handle: string }>,
): string {
  if (items.length === 1) {
    const item = items[0]!;
    return `${item.handle} (${item.dm ? "dm" : `#${item.room}`})`;
  }
  return `rt chat (${items.length} messages)`;
}
