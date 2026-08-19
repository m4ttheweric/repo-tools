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
 * Runs a role hook as `sh -c <hook>`, feeding it `input` as JSON on stdin
 * and expecting `{ env: Record<string,string> }` back as JSON on stdout.
 * Fails open (returns null) on ANY failure: nonzero exit, bad/non-object
 * JSON, a non-string-valued env, timeout, or a spawn error.
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

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc?.kill();
    }, timeoutMs);

    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (timedOut) return null;
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
