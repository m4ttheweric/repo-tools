/**
 * The extracted, testable core of `rt intercept run` (RT-28 Task 7).
 *
 * `runInterception` is the decision tree the generated PATH shims exec into
 * (via `rt intercept run <command> -- "$@"`, see `lib/endpoint/shim.ts`):
 * match the invocation against the loaded rule set, claim a port for the
 * matched role, render env + splice injected args, and exec the real binary.
 * Every dependency that touches the world (git, the daemon, the filesystem,
 * process exec) is injected via `RunDeps` so this stays unit-testable without
 * a daemon, a git repo, or a real subprocess — see
 * `lib/endpoint/__tests__/intercept-run.test.ts`.
 *
 * Fail-open, everywhere: no match, a role not declared in the repo config, or
 * the daemon returning null/an error all fall through to executing the real
 * binary with the caller's original args and env, untouched. The ONE hard
 * failure is `resolveRealBinary` coming back null — there is no real binary
 * to fall open to, so that's a thrown error, never a silent recursion back
 * into the shim (`commands/intercept.ts` owns wiring the real deps; this
 * module never resolves `command` to a path itself, only through the
 * injected `resolveRealBinary`).
 *
 * `RT_INTERCEPT_BYPASS` is NOT handled here — see `commands/intercept.ts`'s
 * header comment; that short-circuit happens before this module is ever
 * called.
 */

import type { HookInput, ResolvedAllocation } from "./env.ts";
import { applyArgInject, collectPreservedKeys, renderEnvTemplates, runRoleHook } from "./env.ts";
import { loadEndpointRepoConfig } from "./config.ts";
import { matchInvocation, type InterceptRule } from "./shim.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RunDeps {
  rules: InterceptRule[];
  gitToplevel(cwd: string): Promise<string | null>;
  gitRemote(toplevel: string): Promise<string | null>;
  claim(payload: { repo: string; worktree: string; role: string; pid: number }): Promise<any | null>;
  execReal(bin: string, args: string[], env: Record<string, string>): Promise<never>;
  resolveRealBinary(command: string): string | null;
  warn(msg: string): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Drops `undefined` values so a caller env (with optional keys) becomes a plain string map. */
function toStringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ─── runInterception ─────────────────────────────────────────────────────────

export async function runInterception(
  deps: RunDeps,
  command: string,
  args: string[],
  cwd: string,
  callerEnv: Record<string, string | undefined>,
  pid: number,
): Promise<never> {
  const debug = callerEnv.RT_INTERCEPT_DEBUG === "1";
  const baseEnv = toStringEnv(callerEnv);

  const execUntouched = (): Promise<never> => {
    const bin = deps.resolveRealBinary(command);
    if (!bin) throw new Error(`rt intercept: real binary for "${command}" could not be resolved`);
    return deps.execReal(bin, args, baseEnv);
  };

  const toplevel = await deps.gitToplevel(cwd);
  const remote = toplevel ? await deps.gitRemote(toplevel) : null;
  const matched = matchInvocation(deps.rules, { command, args, cwd, toplevel, remote });

  if (!matched) return execUntouched();

  const { rule, match } = matched;
  if (debug) {
    deps.warn(`rt-intercept: match command=${command} repo=${rule.repo} role=${match.role} cwd=${cwd}`);
  }

  const repoCfg = loadEndpointRepoConfig(rule.repo);
  const roleCfg = repoCfg.roles[match.role];
  if (!roleCfg) {
    deps.warn(`rt-intercept: passthrough — role "${match.role}" is not declared for repo "${rule.repo}"`);
    return execUntouched();
  }

  // toplevel is guaranteed non-null here: matchInvocation never returns a
  // match when inv.toplevel is null.
  const worktree = toplevel!;
  const claimRes = await deps.claim({ repo: rule.repo, worktree, role: match.role, pid });
  if (debug) {
    deps.warn(`rt-intercept: claim result=${JSON.stringify(claimRes)}`);
  }

  if (!claimRes || !claimRes.ok) {
    deps.warn(`rt-intercept: passthrough — daemon unavailable or claim failed for role "${match.role}"`);
    return execUntouched();
  }

  const alloc: ResolvedAllocation = {
    role: claimRes.data.role,
    port: claimRes.data.port,
    refs: claimRes.data.refs,
  };
  const rendered = renderEnvTemplates(roleCfg.env, alloc);
  const preservedKeys = collectPreservedKeys(roleCfg.preserveEnv, callerEnv);
  // Rendered env keys first, then caller-preserved keys — the order argInject
  // templates (and any human reading the resulting flag) see.
  const envKeys = [...Object.keys(rendered), ...preservedKeys];

  let hookEnv: Record<string, string> = {};
  if (roleCfg.hook) {
    const hookInput: HookInput = { worktree, role: match.role, port: alloc.port, refs: alloc.refs, env: rendered };
    const hookResult = await runRoleHook(roleCfg.hook, hookInput);
    if (hookResult?.env) hookEnv = hookResult.env;
  }

  // Base = caller's env (inheritance preserves exported vars); rendered role
  // env and hook env layer on top, in that order.
  const childEnv: Record<string, string> = { ...baseEnv, ...rendered, ...hookEnv };
  const finalArgs = applyArgInject(args, match.argInject, envKeys);

  const bin = deps.resolveRealBinary(command);
  if (!bin) throw new Error(`rt intercept: real binary for "${command}" could not be resolved`);
  return deps.execReal(bin, finalArgs, childEnv);
}
