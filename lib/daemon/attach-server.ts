/**
 * AttachServer — Unix socket server per process for `rt attach`.
 *
 * Each managed process gets a socket at ~/.rt/attach-<id>.sock. When a
 * client connects, the server replays the last 200 lines of log history,
 * then pipes bidirectionally between the client and the PTY:
 *   - PTY output → socket: via ProcessManager.subscribeToOutput()
 *   - Socket input → PTY: via terminal.write()
 *   - Resize messages ({type:"resize",cols,rows}) from client → terminal.resize()
 *
 * The socket is kept open after crashes so users can read error output.
 * It is explicitly closed at the top of ProcessManager.spawn() before
 * starting a new process, and on explicit kill.
 */

import { unlinkSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { LogBuffer } from "./log-buffer.ts";
import type { ProcessManager } from "./process-manager.ts";

const RT_DIR = join(homedir(), ".rt");

interface ActiveServer {
  listener: ReturnType<typeof Bun.listen>;
  terminal: ReturnType<typeof Bun.Terminal>;
}

export class AttachServer {
  private servers = new Map<string, ActiveServer>();
  private logBuffer: LogBuffer;
  private processManager!: ProcessManager; // set via setProcessManager to break circular dep
  private dataDir: string;

  constructor(deps: { logBuffer: LogBuffer; dataDir?: string }) {
    this.logBuffer = deps.logBuffer;
    this.dataDir = deps.dataDir ?? RT_DIR;
  }

  /** Called after ProcessManager is constructed to wire the subscription mechanism. */
  setProcessManager(pm: ProcessManager): void {
    this.processManager = pm;
  }

  socketPath(id: string): string {
    return join(this.dataDir, `attach-${id}.sock`);
  }

  open(id: string, terminal: ReturnType<typeof Bun.Terminal>): void {
    // Close any existing server for this id
    this.close(id);

    const sockPath = this.socketPath(id);
    mkdirSync(this.dataDir, { recursive: true });

    // Remove stale socket file if present
    try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }

    const logBuffer = this.logBuffer;
    const pm = this.processManager;

    const listener = Bun.listen<{ unsubscribe: (() => void) | null }>({
      unix: sockPath,
      socket: {
        open(socket) {
          socket.data = { unsubscribe: null };

          // Replay buffered history so new attach clients see past output
          const history = logBuffer.getLastLines(id, 200);
          if (history.length > 0) {
            const historyText = history.join("\n") + "\n";
            socket.write(Buffer.from(historyText));
          }

          // Subscribe to live PTY output → forward to socket
          if (pm) {
            socket.data.unsubscribe = pm.subscribeToOutput(id, (chunk: Uint8Array) => {
              try { socket.write(chunk); } catch { /* socket closed */ }
            });
          }
        },

        data(socket, data) {
          // Client input → PTY

          // Check if this is a JSON control message (resize)
          const text = new TextDecoder().decode(data);
          if (text.trimStart().startsWith("{")) {
            try {
              const msg = JSON.parse(text) as { type: string; cols: number; rows: number };
              if (msg.type === "resize") {
                terminal.resize(msg.cols, msg.rows);
                return;
              }
            } catch { /* not valid JSON — treat as regular input */ }
          }

          terminal.write(data);
        },

        close(socket) {
          socket.data?.unsubscribe?.();
        },

        error(socket, err) {
          socket.data?.unsubscribe?.();
          console.error(`[AttachServer] socket error for ${id}:`, err);
        },
      },
    });

    this.servers.set(id, { listener, terminal });
  }

  close(id: string): void {
    const active = this.servers.get(id);
    if (active) {
      try { active.listener.stop(true); } catch { /* ignore */ }
      this.servers.delete(id);
    }

    // Remove the socket file
    const sockPath = this.socketPath(id);
    try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
  }

  closeAll(): void {
    for (const id of [...this.servers.keys()]) this.close(id);
  }
}
