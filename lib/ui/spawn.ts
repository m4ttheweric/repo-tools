/**
 * Spawns rt-ui. stdin stays open until the child exits for every verb: EOF
 * is the child's only signal that we died, so it must never come early.
 */
import { BackNavigation } from "../back-navigation.ts";
import { encodeLine, parsePromptResult, parseSessionLine, PROTOCOL_VERSION, type PromptResult, type PromptSpec, type SessionClosed, type SessionIntent, type StepLevel } from "./protocol.ts";
import { interactive } from "./gate.ts";
import { resolveRtUi } from "./resolve.ts";

type ExitFn = (code: number) => never;
let exitFn: ExitFn = (code) => process.exit(code);

/** The process-exit seam a cancelled prompt leaves through; tests swap it. */
export function exit(code: number): never {
  return exitFn(code);
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

function spawnVerb(verb: "prompt" | "steps" | "session", extra: string[] = []) {
  const bin = resolveRtUi();
  killLiveOnExit();
  const proc = Bun.spawn([bin, verb, ...extra], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  live.add(proc);
  proc.exited.then(() => live.delete(proc));
  return { bin, proc };
}

function fail(bin: string, code: number, stderr: string): never {
  const detail = stderr.trim() || `exit ${code}`;
  process.stderr.write(`\n  rt-ui failed (${detail})\n  binary: ${bin}\n\n`);
  return exit(1);
}

export async function runPrompt(spec: PromptSpec): Promise<PromptResult> {
  const { bin, proc } = spawnVerb("prompt");
  proc.stdin.write(encodeLine(spec));
  proc.stdin.flush();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  proc.stdin.end();
  switch (code) {
    case 0:
      return parsePromptResult(stdout);
    case 130:
      return exit(130);
    case 131:
      throw new BackNavigation();
    default:
      return fail(bin, code, stderr);
  }
}

export interface StepHandle {
  log(level: StepLevel, text: string): void;
  /** Resolves true when rt-ui painted the final line; false when it was dead (caller prints the line itself). */
  done(title?: string, hint?: string): Promise<boolean>;
  fail(title?: string, hint?: string): Promise<boolean>;
}

export function openStep(title: string): StepHandle {
  const { proc } = spawnVerb("steps");
  let dead = false;
  proc.exited.then(() => { dead = true; });

  const send = (msg: object): boolean => {
    if (dead) return false;
    try {
      proc.stdin.write(encodeLine(msg));
      proc.stdin.flush();
      return true;
    } catch {
      dead = true;
      return false;
    }
  };
  send({ t: "hello", protocol: PROTOCOL_VERSION });
  send({ t: "start", title });

  const finish = async (t: "done" | "fail", finalTitle?: string, hint?: string): Promise<boolean> => {
    const sent = send({ t, title: finalTitle ?? title, ...(hint ? { hint } : {}) });
    try { proc.stdin.end(); } catch { /* already closed */ }
    const code = await proc.exited;
    // 130 means Ctrl-C reached the child, which finalized its own line; the
    // parent is handling the same SIGINT, so there is nothing left to print.
    return sent && (code === 0 || code === 130);
  };

  return {
    log: (level, text) => send({ t: "log", level, text }),
    done: (t, h) => finish("done", t, h),
    fail: (t, h) => finish("fail", t, h),
  };
}

export interface SessionEnd {
  reason: SessionClosed["reason"] | "died";
  code: number;
  message?: string;
}

export interface SessionHandle {
  /** User actions, in order, until the child sends closed or dies. */
  intents: AsyncIterable<SessionIntent>;
  /** Full model replacement; a no-op once the child is gone. */
  push(model: unknown): void;
  /** Ask the view to leave the screen; resolves once the child has exited. */
  close(): Promise<SessionEnd>;
  exited: Promise<number>;
}

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

export async function openSession(view: string, model: unknown): Promise<SessionHandle> {
  if (!interactive()) {
    process.stderr.write("rt: this view needs an interactive terminal (set RT_BATCH to skip it in scripts)\n");
    return exit(1);
  }
  const { bin, proc } = spawnVerb("session", ["--view", view]);
  const reader = lines(proc.stdout);
  const first = await reader.next();
  let hello: ReturnType<typeof parseSessionLine> | undefined;
  try {
    hello = first.done ? undefined : parseSessionLine(first.value);
  } catch {
    hello = undefined;
  }
  if (!hello || hello.t !== "hello" || hello.protocol !== PROTOCOL_VERSION || !hello.views.includes(view)) {
    // The child is waiting for open and would wait forever: end its stdin so
    // it sees a dead parent and exits, then report.
    try { proc.stdin.end(); } catch { /* already closed */ }
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    return fail(bin, 2, stderr || `rt-ui session: bad hello ${first.done ? "(stdout closed)" : first.value}`);
  }

  let dead = false;
  let end: SessionEnd | undefined;
  const send = (msg: object): void => {
    if (dead) return;
    try {
      proc.stdin.write(encodeLine(msg));
      proc.stdin.flush();
    } catch {
      dead = true;
    }
  };
  send({ t: "open", view, model });

  // One eager reader owns stdout for the child's whole life: intents queue
  // up for whoever iterates, and the closed line is recorded whether or not
  // anyone is still pulling (a quit intent is usually the last thing the
  // consumer reads before it calls close()).
  const queue: SessionIntent[] = [];
  // A boxed callback, not a bare `let`: a bare closure variable narrows to
  // its initializer (`null`) inside the IIFE below since TS's control-flow
  // analysis does not see the later reassignment in the sibling `intents()`
  // closure.
  const waker: { fn: (() => void) | null } = { fn: null };
  let stdoutDone = false;
  const drained = (async () => {
    for await (const line of reader) {
      let msg;
      try {
        msg = parseSessionLine(line);
      } catch {
        continue;
      }
      if (msg.t === "intent") queue.push(msg);
      if (msg.t === "closed") end = { reason: msg.reason, code: 0, ...(msg.message ? { message: msg.message } : {}) };
      waker.fn?.();
    }
    stdoutDone = true;
    waker.fn?.();
  })();
  const exited = proc.exited.then((code) => {
    dead = true;
    return code;
  });

  async function* intents(): AsyncGenerator<SessionIntent> {
    while (true) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (end || stdoutDone) return;
      await new Promise<void>((r) => { waker.fn = r; });
      waker.fn = null;
    }
  }

  return {
    intents: intents(),
    push: (m) => send({ t: "model", model: m }),
    exited,
    async close() {
      send({ t: "close" });
      const code = await exited;
      await drained;
      // stdin stays open until the child is gone: EOF is its parent-death signal.
      try { proc.stdin.end(); } catch { /* already closed */ }
      if (end) return { ...end, code };
      return { reason: "died", code };
    },
  };
}

export const __test__ = {
  setExit(fn: ExitFn | undefined): void {
    exitFn = fn ?? ((code) => process.exit(code));
  },
};
