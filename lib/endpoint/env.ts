/**
 * Pure helpers for computing the child process env and args of an
 * intercepted command: env template rendering, preserveEnv expansion,
 * argInject splicing, and the fail-open role hook.
 *
 * All four functions here are pure or self-contained — no daemon
 * involvement, no rt-paths needed. The interceptor (a later task) is the
 * only consumer.
 */

import type { ArgInject } from "./config.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedAllocation {
  role: string;
  port: number;
  refs: Record<string, { port: number; url: string; running: boolean }>;
}

export interface HookInput {
  worktree: string;
  role: string;
  port: number;
  refs: ResolvedAllocation["refs"];
  env: Record<string, string>;
}

// ─── renderEnvTemplates ──────────────────────────────────────────────────────

const TEMPLATE_RE = /\$\{port\}|\$\{roles\.([A-Za-z0-9_-]+)\.port\}/g;

/**
 * Renders `${port}` and `${roles.<name>.port}` placeholders in each env
 * template value against the resolved allocation. A reference to a role not
 * present in `alloc.refs` renders as an empty string rather than throwing or
 * warning.
 */
export function renderEnvTemplates(env: Record<string, string>, alloc: ResolvedAllocation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(TEMPLATE_RE, (_match, roleName: string | undefined) => {
      if (roleName === undefined) return String(alloc.port);
      const ref = alloc.refs[roleName];
      return ref ? String(ref.port) : "";
    });
  }
  return out;
}

// ─── collectPreservedKeys ────────────────────────────────────────────────────

/**
 * Resolves a role's `preserveEnv` declarations against the caller's actual
 * environment. Exact names are kept only if present (value may be an empty
 * string; only `undefined` counts as absent). A trailing `*` is a prefix
 * match, expanded to every present key with that prefix.
 */
export function collectPreservedKeys(preserveEnv: string[], callerEnv: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const entry of preserveEnv) {
    if (entry.endsWith("*")) {
      const prefix = entry.slice(0, -1);
      for (const key of Object.keys(callerEnv)) {
        if (key.startsWith(prefix) && callerEnv[key] !== undefined) out.push(key);
      }
    } else if (callerEnv[entry] !== undefined) {
      out.push(entry);
    }
  }
  return out;
}

// ─── applyArgInject ──────────────────────────────────────────────────────────

/**
 * Splices an injected arg after the anchor arg (`afterArg`), unless an arg
 * equal to or starting with `skipIfArgPresent` is already present, or the
 * anchor itself isn't found (in either case, args are returned unchanged).
 */
export function applyArgInject(args: string[], inject: ArgInject | undefined, envKeys: string[]): string[] {
  if (!inject) return args;
  const alreadyPresent = args.some((arg) => arg === inject.skipIfArgPresent || arg.startsWith(inject.skipIfArgPresent));
  if (alreadyPresent) return args;
  const anchorIndex = args.indexOf(inject.afterArg);
  if (anchorIndex === -1) return args;
  const rendered = inject.template.replace("${envKeys}", envKeys.join(","));
  const out = [...args];
  out.splice(anchorIndex + 1, 0, rendered);
  return out;
}

// ─── runRoleHook ─────────────────────────────────────────────────────────────

/**
 * Reads a subprocess pipe to EOF, returning both the accumulated text and a
 * `cancel()` that abandons the read.
 *
 * A hook is `sh -c`, so a backgrounded child (`sleep 60 & echo '{}'`) inherits
 * the stdout/stderr pipes and holds them open long after sh itself exits.
 * `new Response(stream).text()` would then never resolve, and killing sh does
 * nothing (it is already gone) — so the read must be abandonable, not merely
 * raced. We own the reader (rather than handing the stream to Response) purely
 * so `cancel()` can release the pipe on the deadline path.
 */
function readPipe(stream: ReadableStream<Uint8Array>): { text: Promise<string>; cancel: () => void } {
  const reader = stream.getReader();
  const text = (async () => {
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  })().catch(() => "");
  return {
    text,
    cancel: () => {
      // Cancel rejects the in-flight read; the `.catch` above absorbs it.
      reader.cancel().catch(() => {});
    },
  };
}

const HOOK_KILL_GRACE_MS = 200;

/**
 * Runs a role hook as `sh -c <hook>`, feeding it `input` as JSON on stdin
 * and expecting `{ env: Record<string,string> }` back as JSON on stdout.
 * Fails open (returns null) on ANY failure: nonzero exit, bad/non-object
 * JSON, a non-string-valued env, timeout, or a spawn error.
 *
 * The timeout is a HARD bound on the whole call, not just on the child's
 * lifetime: the deadline races the entire collect (both pipe reads + exit),
 * and on expiry we SIGTERM, give the process a short grace, SIGKILL, abandon
 * the reads and return null. Nothing after the deadline ever blocks on a pipe
 * that a backgrounded grandchild may hold open forever.
 */
export async function runRoleHook(hook: string, input: HookInput, timeoutMs = 5000): Promise<{ env?: Record<string, string> } | null> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    proc = Bun.spawn(["sh", "-c", hook], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    const outPipe = readPipe(proc.stdout);
    // stderr is drained (and discarded) purely so a chatty hook can't wedge on
    // a full pipe buffer while we wait for stdout.
    const errPipe = readPipe(proc.stderr);

    const TIMED_OUT = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });

    const collect = (async () => {
      const [stdout, , exitCode] = await Promise.all([outPipe.text, errPipe.text, proc!.exited]);
      return { stdout, exitCode };
    })();

    const settled = await Promise.race([collect, deadline]);
    clearTimeout(timer);

    if (settled === TIMED_OUT) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // already gone
      }
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, HOOK_KILL_GRACE_MS))]);
      try {
        proc.kill("SIGKILL");
      } catch {
        // already reaped
      }
      outPipe.cancel();
      errPipe.cancel();
      return null;
    }

    const { stdout, exitCode } = settled;
    if (exitCode !== 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const envRaw = (parsed as Record<string, unknown>).env;
    if (envRaw === undefined) return {};
    if (!envRaw || typeof envRaw !== "object" || Array.isArray(envRaw)) return null;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(envRaw as Record<string, unknown>)) {
      if (typeof value !== "string") return null;
      env[key] = value;
    }
    return { env };
  } catch {
    return null;
  }
}
