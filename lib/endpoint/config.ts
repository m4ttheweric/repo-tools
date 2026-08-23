/**
 * Endpoint config: the reader for a repo's dev-role and intercept declarations
 * (`rt.roles`, `rt.intercepts`), resolved through the settings resolver
 * (RT-47).
 *
 * ── Where the values come from ────────────────────────────────────────────
 * Everything goes through `lib/settings/resolve.ts#getSetting`, which layers
 * the authored stores:
 *
 *   default < team < user < team.repo < user.repo < machine < machine.repo
 *
 * The store rungs are keyed by repo IDENTITY (a normalized remote), which is
 * why the entry point takes one. A null identity — a repo whose remote is a
 * local path, or one whose identity could not be derived — simply makes the
 * `*.repo` rungs unreachable; global keys still answer. That is an honest
 * degrade, not an error.
 *
 * ── Sanitizers still apply to every rung ──────────────────────────────────
 * The resolver only type-checks the TOP level of a value (`rt.roles` is an
 * object, `rt.intercepts` is an array), so the sanitizers below are what
 * actually guarantee the `EndpointRepoConfig` shape. They run over whatever
 * the resolver returns, from whichever scope it came.
 *
 * ── Variables ─────────────────────────────────────────────────────────────
 * Values are expanded (`expand: true`): `${team:<name>}` and `${home}` always,
 * and `${repoRoot}` when the repo is registered in repos.json (this module
 * looks the path up itself, so all four callers get it for free). Domain
 * templates the interceptor owns — `${port}`, `${roles.<name>.port}`,
 * `${envKeys}` — pass through untouched, by design. `${worktree}` is NOT
 * satisfiable here (this reader has no invocation context; a hook receives the
 * worktree through its HookInput instead), so a value using it degrades — see
 * below.
 *
 * ── This reader never throws ──────────────────────────────────────────────
 * The pre-resolver contract was "missing file or malformed shapes degrade to
 * empty defaults rather than throwing", and every caller still depends on it:
 * `run.ts` sits in front of every intercepted command invocation and is
 * fail-open by design, and the daemon's claim/lookup handlers must answer
 * rather than blow up. `getSetting` DOES throw for one input — an unsatisfiable
 * closed-set variable — so that single key degrades to empty with one warning
 * rather than propagating. Emitting a half-expanded path would be worse than
 * either.
 */

import { loadRepoIndex } from "../repo-index.ts";
import { getSetting, type ResolveOpts } from "../settings/resolve.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RoleConfig {
  pool: number[]; // flattened, ascending, deduped; [] = non-allocating
  fixedPort?: number; // non-allocating role (frontend)
  needs: string[]; // role references, default []
  preserveEnv: string[]; // caller env vars to protect; trailing * = prefix match
  env: Record<string, string>; // templates: ${port}, ${roles.<name>.port}
  hook?: string; // command string, run by the interceptor, fail-open
}

export interface ArgInject {
  afterArg: string;
  template: string;
  skipIfArgPresent: string;
}

export interface InterceptMatch {
  cwdGlob: string;
  argPattern?: string;
  role: string;
  argInject?: ArgInject;
}

export interface InterceptConfig {
  command: string;
  matches: InterceptMatch[];
}

export interface EndpointRepoConfig {
  roles: Record<string, RoleConfig>;
  intercepts: InterceptConfig[];
}

// ─── Sanitizers ──────────────────────────────────────────────────────────────

/**
 * Flattens a raw pool declaration into a sorted, deduped list of positive
 * integer ports. Entries may be a bare port number or a `{from, to}` range
 * (inclusive). Anything else (wrong shape, non-integer, non-positive,
 * inverted range) is silently dropped rather than throwing.
 */
function flattenPool(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const item of raw) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) {
      out.add(item);
    } else if (item && typeof item === "object") {
      const { from, to } = item as { from?: unknown; to?: unknown };
      if (typeof from === "number" && typeof to === "number" && to >= from) {
        for (let p = from; p <= to; p++) out.add(p);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Keeps only string entries of a raw array; returns [] for a non-array. */
function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

/** Keeps only string values of a raw object; returns {} for a non-object. */
function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Sanitizes one role entry. Returns null for a malformed (non-object) role. */
function sanitizeRole(raw: unknown): RoleConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const role: RoleConfig = {
    pool: flattenPool(r.pool),
    needs: stringArray(r.needs),
    preserveEnv: stringArray(r.preserveEnv),
    env: stringRecord(r.env),
  };
  if (typeof r.fixedPort === "number" && Number.isInteger(r.fixedPort) && r.fixedPort > 0) {
    role.fixedPort = r.fixedPort;
  }
  if (typeof r.hook === "string" && r.hook.length > 0) {
    role.hook = r.hook;
  }
  return role;
}

/** Sanitizes the "roles" map, dropping malformed entries by key. */
function sanitizeRoles(raw: unknown): Record<string, RoleConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, RoleConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const role = sanitizeRole(value);
    if (role) out[name] = role;
  }
  return out;
}

/** Compiles `argPattern` as a sanity check; drops it (not the whole match) on failure. */
function sanitizeArgPattern(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    // eslint-disable-next-line no-new -- compile-only sanity check
    new RegExp(raw);
    return raw;
  } catch {
    return undefined;
  }
}

function sanitizeArgInject(raw: unknown): ArgInject | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  if (typeof a.afterArg === "string" && typeof a.template === "string" && typeof a.skipIfArgPresent === "string") {
    return { afterArg: a.afterArg, template: a.template, skipIfArgPresent: a.skipIfArgPresent };
  }
  return undefined;
}

/** Sanitizes one intercept match. Returns null when required string fields are missing. */
function sanitizeMatch(raw: unknown): InterceptMatch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.cwdGlob !== "string" || typeof m.role !== "string") return null;

  const match: InterceptMatch = { cwdGlob: m.cwdGlob, role: m.role };
  const argPattern = sanitizeArgPattern(m.argPattern);
  if (argPattern !== undefined) match.argPattern = argPattern;
  const argInject = sanitizeArgInject(m.argInject);
  if (argInject !== undefined) match.argInject = argInject;
  return match;
}

/** Sanitizes one intercept entry. Returns null when command or matches is malformed. */
function sanitizeIntercept(raw: unknown): InterceptConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const i = raw as Record<string, unknown>;
  if (typeof i.command !== "string" || i.command.length === 0) return null;
  if (!Array.isArray(i.matches)) return null;

  const matches: InterceptMatch[] = [];
  for (const m of i.matches) {
    const match = sanitizeMatch(m);
    if (match) matches.push(match);
  }
  return { command: i.command, matches };
}

/** Sanitizes the "intercepts" array, dropping malformed entries. */
function sanitizeIntercepts(raw: unknown): InterceptConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: InterceptConfig[] = [];
  for (const entry of raw) {
    const intercept = sanitizeIntercept(entry);
    if (intercept) out.push(intercept);
  }
  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * The registered path for `repoName`, or undefined when it isn't in the repo
 * index. Only used to satisfy `${repoRoot}` — a name the index doesn't know
 * still resolves everything that doesn't need one.
 */
function repoRootFor(repoName: string): string | undefined {
  return loadRepoIndex()[repoName];
}

/**
 * One resolved key, sanitized by the caller. An unsatisfiable closed-set
 * variable is the only way `getSetting` throws (see the module header): warn
 * and degrade THIS key to undefined, so a bad `${repoRoot}` in `rt.roles`
 * cannot also take `rt.intercepts` — or the whole invocation — down with it.
 */
function resolveKey(key: string, repoName: string, opts: ResolveOpts): unknown {
  try {
    return getSetting<unknown>(key, opts).value;
  } catch (err) {
    console.warn(`rt: ignoring "${key}" for repo "${repoName}" — ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Resolves a repo's `rt.roles` and `rt.intercepts` into the endpoint config
 * shape. `repoIdentity` selects the stores' `repos.<identity>` sections (null
 * = unreachable, global scopes only); `repoName` resolves `${repoRoot}`.
 *
 * Never throws: missing files, malformed shapes and unexpandable values all
 * degrade to empty defaults (module header explains why every caller needs
 * that).
 */
export function loadEndpointConfig(args: { repoIdentity: string | null; repoName: string }): EndpointRepoConfig {
  const { repoIdentity, repoName } = args;
  const repoRoot = repoRootFor(repoName);
  const opts: ResolveOpts = {
    repoIdentity,
    expand: true,
    ...(repoRoot === undefined ? {} : { expandCtx: { repoRoot } }),
  };

  return {
    roles: sanitizeRoles(resolveKey("rt.roles", repoName, opts)),
    intercepts: sanitizeIntercepts(resolveKey("rt.intercepts", repoName, opts)),
  };
}
