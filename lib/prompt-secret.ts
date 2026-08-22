/**
 * Shared no-echo prompt for `rt secrets set/rotate` and `rt home key import`:
 * raw mode so keystrokes never reach the terminal, and nothing is echoed
 * back (not even asterisks) — the value never touches argv, so this is the
 * only place it's typed. `io` is injectable so tests drive a fake stdin
 * instead of a real TTY.
 */

const CTRL_C = "";
const DEL = "";

export interface PromptStdin {
  isTTY: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  removeListener(event: "data", listener: (chunk: Buffer) => void): void;
}

export interface PromptIO {
  stdin: PromptStdin;
  write(text: string): void;
}

function defaultPromptIO(): PromptIO {
  return {
    stdin: process.stdin as unknown as PromptStdin,
    write: (text) => process.stdout.write(text),
  };
}

export function promptSecret(message: string, io: PromptIO = defaultPromptIO()): Promise<string> {
  if (!io.stdin.isTTY) {
    return Promise.reject(new Error(`${message}: not a TTY — pass --stdin to read the value from stdin instead`));
  }
  io.write(`${message}: `);
  return new Promise((resolve, reject) => {
    const stdin = io.stdin;
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          io.write("\n");
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          io.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === DEL || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}
