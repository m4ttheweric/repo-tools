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

  const attempt = new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(line);
          socket.end();
          resolve({ ok: true });
        },
        data() {},
        error(_socket, error) {
          resolve({ ok: false, error: error.message });
        },
      },
    }).catch((error: unknown) => {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  });

  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
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
