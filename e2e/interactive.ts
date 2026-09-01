import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createConnection, type Socket } from "net";
import { RT_BINARY } from "./harness.ts";

function findTermwright(): string {
  const candidates = [
    process.env.TERMWRIGHT_BINARY,
    join(homedir(), ".cargo/bin/termwright"),
    "/usr/local/bin/termwright",
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(
    "termwright not found. Install with: cargo install termwright",
  );
}

const TERMWRIGHT = findTermwright();

export interface StartInteractiveOpts {
  args: string[];
  home: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  cwd?: string;
  timeoutMs?: number;
}

export interface TermwrightSession {
  screen(): Promise<string>;
  press(key: string): Promise<void>;
  type(text: string): Promise<void>;
  ctrl(char: string): Promise<void>;
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  waitForIdle(idleMs?: number, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
  readonly exitCode: Promise<number>;
}

let nextId = 0;

const CTRL_ARROW_SEQUENCES: Record<string, number[]> = {
  up: [0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41],
  down: [0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x42],
  right: [0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x43],
  left: [0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44],
};

function twSend(
  socketPath: string,
  method: string,
  params: Record<string, unknown> | null = null,
  socketTimeoutMs = 15_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const msg = JSON.stringify({ id, method, params });
    let data = "";
    let settled = false;

    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    }

    const socket: Socket = createConnection(socketPath, () => {
      socket.write(msg + "\n");
    });

    socket.on("data", (chunk) => {
      data += chunk.toString();
      // Termwright may keep the connection open -- try to parse as soon
      // as we have a complete JSON object.
      try {
        const parsed = JSON.parse(data);
        settle(() => {
          socket.destroy();
          if (parsed.error) {
            reject(
              new Error(
                `Termwright ${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
              ),
            );
          } else {
            resolve(parsed.result);
          }
        });
      } catch {
        // Incomplete JSON -- wait for more data
      }
    });

    socket.on("end", () => {
      settle(() => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(
              new Error(
                `Termwright ${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
              ),
            );
          } else {
            resolve(parsed.result);
          }
        } catch {
          reject(
            new Error(
              `Termwright ${method}: invalid JSON response: ${data.slice(0, 200)}`,
            ),
          );
        }
      });
    });

    socket.on("error", (err) => {
      settle(() =>
        reject(new Error(`Termwright socket error (${method}): ${err.message}`)),
      );
    });

    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(
          new Error(
            `Termwright ${method}: socket timeout after ${socketTimeoutMs}ms`,
          ),
        );
      });
    }, socketTimeoutMs);
  });
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    await Bun.sleep(100);
  }
  throw new Error(
    `Termwright socket did not appear at ${path} within ${timeoutMs}ms`,
  );
}

export async function startInteractive(
  opts: StartInteractiveOpts,
): Promise<TermwrightSession> {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 30;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const cwd = opts.cwd ?? opts.home;
  const socketPath = join(opts.home, `.tw-${process.pid}-${++nextId}.sock`);

  // Some spawned children may exec a script with a `#!/usr/bin/env bun`
  // shebang, so bun's own directory must be on PATH for the spawned rt
  // binary's children to find it. process.execPath is the running bun binary
  // itself, which resolves correctly whether bun was installed via the bun
  // installer (~/.bun/bin) or Homebrew (/opt/homebrew/bin) -- unlike a
  // hardcoded guess.
  const bunDir = join(process.execPath, "..");

  const env: Record<string, string> = {
    // HERDR_* must never reach the binary under test: rt's herdr-launch path
    // would drive the developer's live herdr session (split panes, type into
    // the focused pane) instead of staying inside the test sandbox.
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] != null && !e[0].startsWith("HERDR_"),
      ),
    ),
    HOME: opts.home,
    PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
    TERM: "xterm-256color",
    RT_SKIP_SETUP: "1",
    ...opts.env,
  };

  // Termwright doesn't propagate cwd to the child process. Wrap the
  // command in `bash -c 'cd <cwd> && exec <binary> ...'` so the child
  // starts in the right directory.
  const rtCmd = [RT_BINARY, ...opts.args]
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const wrappedCmd = `cd '${cwd}' && exec ${rtCmd}`;

  const proc = Bun.spawn(
    [
      TERMWRIGHT,
      "daemon",
      "--socket",
      socketPath,
      "--cols",
      String(cols),
      "--rows",
      String(rows),
      "--",
      "bash",
      "-c",
      wrappedCmd,
    ],
    {
      env,
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  await waitForSocket(socketPath, timeoutMs);

  let stopped = false;

  return {
    async screen(): Promise<string> {
      const result = await twSend(socketPath, "screen", { format: "text" });
      return typeof result === "string" ? result : String(result);
    },

    async press(key: string): Promise<void> {
      await twSend(socketPath, "press", { key });
    },

    async type(text: string): Promise<void> {
      await twSend(socketPath, "type", { text });
    },

    async ctrl(char: string): Promise<void> {
      const seq = CTRL_ARROW_SEQUENCES[char.toLowerCase()];
      if (seq) {
        const b64 = Buffer.from(seq).toString("base64");
        await twSend(socketPath, "raw", { bytes_base64: b64 });
      } else {
        await twSend(socketPath, "hotkey", { ctrl: true, ch: char });
      }
    },

    async waitForText(text: string, timeoutMs = 5000): Promise<void> {
      // The transport socket timeout must outlast the logical wait, or a wait
      // longer than the default 15s dies at the socket layer before the text
      // can appear.
      await twSend(
        socketPath,
        "wait_for_text",
        { text, timeout_ms: timeoutMs },
        timeoutMs + 5000,
      );
    },

    async waitForIdle(idleMs = 500, timeoutMs = 5000): Promise<void> {
      await twSend(
        socketPath,
        "wait_for_idle",
        { idle_ms: idleMs, timeout_ms: timeoutMs },
        timeoutMs + 5000,
      );
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await twSend(socketPath, "close", null);
      } catch {}
      try {
        proc.kill();
      } catch {}
    },

    get exitCode(): Promise<number> {
      return proc.exited;
    },
  };
}
