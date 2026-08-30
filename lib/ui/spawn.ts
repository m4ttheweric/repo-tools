/**
 * Spawns rt-ui. stdin stays open until the child exits for every verb: EOF
 * is the child's only signal that we died, so it must never come early.
 */
import { BackNavigation } from "../back-navigation.ts";
import { encodeLine, parsePromptResult, PROTOCOL_VERSION, type PromptResult, type PromptSpec, type StepLevel } from "./protocol.ts";
import { resolveRtUi } from "./resolve.ts";

type ExitFn = (code: number) => never;
let exitFn: ExitFn = (code) => process.exit(code);

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

function spawnVerb(verb: "prompt" | "steps") {
  const bin = resolveRtUi();
  killLiveOnExit();
  const proc = Bun.spawn([bin, verb], {
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
  return exitFn(1);
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
      return exitFn(130);
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

export const __test__ = {
  setExit(fn: ExitFn | undefined): void {
    exitFn = fn ?? ((code) => process.exit(code));
  },
};
