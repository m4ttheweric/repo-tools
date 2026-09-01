/**
 * TS side of the rt-ui `pick` verb: a long-lived, bidirectional NDJSON
 * session (request, then any number of update/modal in, event/modal-result
 * out, exactly one terminal result). Unlike prompt/steps/session, pick has
 * no /dev/tty escape hatch -- the Go side reads keys and paints straight on
 * the caller's real terminal -- so a non-TTY parent has nowhere to run it.
 */
import { encodeLine } from "./protocol.ts";
import { resolveRtUi } from "./resolve.ts";
import { PROTOCOL_VERSION, type PickEvent, type PickModalResult, type PickRequest, type PickResult, type PickRow, type PickUpdate } from "./protocol.ts";

export interface PickHandle {
  update(patch: Omit<PickUpdate, "t">): void;
  modal(message: string, rows: PickRow[]): Promise<string | null>;
  result: Promise<PickResult>;
}

export interface PickCallbacks {
  onEvent?: (e: PickEvent) => void | Promise<void>;
}

/** Takes the already-stamped request so the wire framing lives in one place, shared by the real spawn and any injected fake. */
export type PickImpl = (req: PickRequest, cb: PickCallbacks) => PickHandle;

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) yield buf;
}

const live = new Set<ReturnType<typeof Bun.spawn>>();
let exitHookInstalled = false;

function killLiveOnExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const p of live) {
      try { p.kill("SIGTERM"); } catch { /* already gone */ }
    }
  });
}

function spawnPick(req: PickRequest, cb: PickCallbacks): PickHandle {
  // A misuse assertion, not the graceful RT_BATCH-style gate the wrapper
  // layer applies before ever calling runPick: there is no /dev/tty fallback
  // to degrade to here, so a non-TTY parent is a programming error.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("rt-ui pick: requires an interactive terminal (stdin/stderr must be TTYs)");
  }

  const bin = resolveRtUi();
  killLiveOnExit();
  const proc = Bun.spawn([bin, "pick"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  live.add(proc);
  proc.exited.then(() => live.delete(proc));
  // Read concurrently from the start: nothing else drains stderr, and an
  // unread pipe can fill and block the child if left until the end.
  const stderrText = new Response(proc.stderr).text();

  const send = (msg: object): void => {
    proc.stdin.write(encodeLine(msg));
    proc.stdin.flush();
  };
  send(req);

  let resolveResult!: (r: PickResult) => void;
  let rejectResult!: (e: unknown) => void;
  let settled = false;
  const result = new Promise<PickResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const pendingModals: Array<(v: string | null) => void> = [];

  // Events stream in on one stdout pipe; chaining each dispatch onto the
  // previous one is what guarantees onEvent finishes with one event before
  // the next is delivered, without blocking the reader from picking up a
  // modal-result or the terminal result in the meantime.
  let eventChain: Promise<void> = Promise.resolve();

  (async () => {
    for await (const line of lines(proc.stdout)) {
      let msg: { t?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.t === "event") {
        const evt = msg as unknown as PickEvent;
        eventChain = eventChain.then(() => cb.onEvent?.(evt));
      } else if (msg.t === "modal-result") {
        const mr = msg as unknown as PickModalResult;
        pendingModals.shift()?.(mr.value);
      } else if (msg.t === "result" && !settled) {
        settled = true;
        const r = msg as unknown as PickResult;
        // Wait for any event callbacks already queued so the terminal
        // result never resolves ahead of them.
        eventChain = eventChain.then(() => resolveResult(r));
      }
    }
    await eventChain;
    if (!settled) {
      settled = true;
      const stderr = await stderrText;
      rejectResult(new Error(`rt-ui pick: exited without a result${stderr.trim() ? ` (${stderr.trim()})` : ""}`));
    }
  })();

  return {
    update(patch) {
      send({ t: "update", ...patch });
    },
    modal(message, rows) {
      return new Promise<string | null>((resolve) => {
        pendingModals.push(resolve);
        send({ t: "modal", message, rows });
      });
    },
    result,
  };
}

let impl: PickImpl = spawnPick;

export function runPick(req: Omit<PickRequest, "t" | "protocol">, cb: PickCallbacks = {}): PickHandle {
  const full: PickRequest = { t: "pick", protocol: PROTOCOL_VERSION, ...req };
  return impl(full, cb);
}

export const __test__ = {
  setImpl(fn: PickImpl | undefined): void {
    impl = fn ?? spawnPick;
  },
};
