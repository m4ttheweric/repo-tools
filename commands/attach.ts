/**
 * rt attach <id> — Connect terminal to a daemon-managed process PTY.
 *
 * Opens the Unix socket created by AttachServer for the given process id,
 * puts stdin in raw mode, and bidirectionally pipes:
 *   stdin  → socket → daemon PTY (process input)
 *   socket → stdout          (process output)
 *
 * Resize events (SIGWINCH) are sent as JSON {type:"resize",cols,rows}.
 * Ctrl+Q (codepoint 17) detaches cleanly without killing the process.
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { daemonQuery } from "../lib/daemon-client.ts";

export async function attachProcess(args: string[], _ctx: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    process.stderr.write("Usage: rt attach <process-id>\n");
    process.exit(1);
  }

  // Ask daemon for the attach socket path
  const res = await daemonQuery("process:attach-info", { id });
  if (!res || !res.ok || !res.data?.socketPath) {
    process.stderr.write(`No attach socket found for process "${id}". Is the daemon running?\n`);
    process.exit(1);
  }

  const { socketPath } = res.data as { socketPath: string };

  // Set stdin to raw mode so all keystrokes go straight to the PTY
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  let detached = false;

  const cleanup = () => {
    if (detached) return;
    detached = true;
    try { if (process.stdin.setRawMode) process.stdin.setRawMode(false); } catch { /* */ }
    try { socket?.end(); } catch { /* */ }
  };

  const sendResize = () => {
    if (!socket) return;
    const msg = JSON.stringify({
      type: "resize",
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    });
    try { socket.write(Buffer.from(msg)); } catch { /* */ }
  };

  // Connect to the attach socket
  socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_sock, data) {
        process.stdout.write(data);
      },
      close() {
        cleanup();
        process.exit(0);
      },
      error(_sock, err) {
        process.stderr.write(`\nAttach error: ${err}\n`);
        cleanup();
        process.exit(1);
      },
      open(_sock) {
        // Send current terminal size on connect
        sendResize();
      },
    },
  });

  // Pipe stdin → socket; intercept Ctrl+Q (byte 17) to detach
  process.stdin.on("data", (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 17) {
        // Ctrl+Q — detach
        process.stdout.write("\r\n[detached]\r\n");
        cleanup();
        process.exit(0);
      }
    }
    try { socket?.write(chunk); } catch { /* socket closed */ }
  });

  process.stdin.on("end", () => {
    cleanup();
    process.exit(0);
  });

  // Forward terminal resize events
  process.on("SIGWINCH", sendResize);

  // Keep the process alive
  await new Promise<void>((resolve) => {
    process.once("exit", resolve);
  });
}
