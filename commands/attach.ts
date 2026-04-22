/**
 * rt attach [id] — Connect terminal to a daemon-managed process PTY.
 *
 * Opens the Unix socket created by AttachServer for the given process id,
 * puts stdin in raw mode, and bidirectionally pipes:
 *   stdin  → socket → daemon PTY (process input)
 *   socket → stdout          (process output)
 *
 * Resize events (SIGWINCH) are sent as JSON {type:"resize",cols,rows}.
 * Ctrl+Q (codepoint 17) detaches cleanly without killing the process.
 *
 * If no id is given, shows a picker of all daemon-managed processes.
 */

import type { CommandContext } from "../lib/command-tree.ts";
import { daemonQuery } from "../lib/daemon-client.ts";
import { green, red, dim, reset, bold } from "../lib/tui.ts";

// ─── Process picker ──────────────────────────────────────────────────────────

async function pickProcess(): Promise<string | null> {
  const [listRes, statesRes] = await Promise.all([
    daemonQuery("process:list"),
    daemonQuery("process:states"),
  ]);

  if (!listRes?.ok || !Array.isArray(listRes.data) || listRes.data.length === 0) {
    process.stderr.write(
      "\n  No daemon-managed processes found.\n" +
      "  Start a process via the runner first: rt runner\n\n"
    );
    return null;
  }

  const states: Record<string, string> = statesRes?.ok ? statesRes.data : {};

  const { filterableSelect } = await import("../lib/rt-render.tsx");

  // Sort: running first, then crashed, then stopped/warm
  const priority = (s: string) =>
    s === "running" ? 0 : s === "crashed" ? 1 : 2;

  const entries = (listRes.data as { id: string; config: { cmd: string; cwd: string } }[])
    .slice()
    .sort((a, b) => priority(states[a.id] ?? "stopped") - priority(states[b.id] ?? "stopped"));

  const stateLabel = (id: string): string => {
    const s = states[id] ?? "stopped";
    switch (s) {
      case "running":  return `${green}● running${reset}`;
      case "crashed":  return `${red}✖ crashed${reset}`;
      case "starting": return `${dim}◌ starting${reset}`;
      case "stopping": return `${dim}◌ stopping${reset}`;
      case "warm":     return `${dim}◌ warm${reset}`;
      default:         return `${dim}○ stopped${reset}`;
    }
  };

  const options = entries.map(({ id, config }) => ({
    value: id,
    label: `${bold}${id}${reset}`,
    hint: `${stateLabel(id)}  ${dim}${config.cwd.replace(process.env.HOME ?? "", "~")}  ${config.cmd}${reset}`,
  }));

  const selected = await filterableSelect({
    message: "Attach to process",
    options,
  });

  return selected ?? null;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function attachProcess(args: string[], _ctx: CommandContext): Promise<void> {
  let id = args[0];

  if (!id) {
    const picked = await pickProcess();
    if (!picked) process.exit(0);
    id = picked;
  }

  // Ask daemon for the attach socket path and current process state
  const res = await daemonQuery("process:attach-info", { id });
  if (!res || !res.ok) {
    process.stderr.write(`No attach socket found for process "${id}". Is the daemon running?\n`);
    process.exit(1);
  }

  const { socketPath, state } = res.data as { socketPath: string | null; state: string };

  // No live socket — process is stopped/crashed.
  // Show the log tail, then poll until the process starts and a socket appears.
  if (!socketPath) {
    const logsRes = await daemonQuery("process:logs", { id, n: 200 });
    const lines: string[] = logsRes?.data ?? [];
    if (lines.length > 0) {
      process.stdout.write(lines.join("\n") + "\n");
    }

    // Poll until a socket appears (i.e. the process has been started)
    let currentState = state;
    while (true) {
      const stateLabel = currentState === "crashed"
        ? "\x1b[31mcrashed\x1b[0m"
        : "\x1b[2mstopped\x1b[0m";
      process.stdout.write(`\r\x1b[2m── ${stateLabel}\x1b[2m ─ press [s] to start ──\x1b[0m\x1b[K`);
      await Bun.sleep(1000);

      const pollRes = await daemonQuery("process:attach-info", { id });
      if (pollRes?.ok && pollRes.data?.socketPath) break; // socket appeared — reconnect
      currentState = pollRes?.data?.state ?? currentState;
    }
    // Clear the status line and fall through to connect normally
    process.stdout.write("\r\x1b[K");
    // Re-fetch socket path
    const reconnectRes = await daemonQuery("process:attach-info", { id });
    if (!reconnectRes?.ok || !reconnectRes.data?.socketPath) process.exit(1);
    // Restart this invocation by re-running (exit 0 → attach loop will re-exec immediately)
    process.exit(0);
  }

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
    try { process.stdin.pause(); } catch { /* */ }
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

  // Connect to the attach socket.
  // Guard against the race where the daemon closes+recreates the socket between
  // our attach-info query and this connect call (e.g. during a spawn/respawn).
  // ENOENT / ECONNREFUSED → exit 0 so the shell attach-loop retries immediately.
  try {
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
  } catch (err: any) {
    // Socket vanished between query and connect (daemon is mid-respawn) — retry.
    const code = err?.code ?? "";
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      process.exit(0); // shell loop will re-exec attach immediately
    }
    process.stderr.write(`Failed to connect: ${err}\n`);
    process.exit(1);
  }

  // Pipe stdin → socket; intercept Ctrl+Q (byte 17) to detach cleanly,
  // and Ctrl+C (byte 3) to exit — in raw mode Ctrl+C is NOT converted to
  // SIGINT, it arrives here as a plain byte and must be handled explicitly.
  process.stdin.on("data", (chunk: Buffer) => {
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 17) {
        // Ctrl+Q — detach without killing the process
        process.stdout.write("\r\n[detached]\r\n");
        cleanup();
        process.exit(0);
      }
      if (chunk[i] === 3) {
        // Ctrl+C — detach and exit
        process.stdout.write("\r\n");
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
