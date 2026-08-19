/**
 * Endpoint config: reads the "roles" and "intercepts" keys of the shared
 * per-repo config.json (~/.mattstack/rt/repos/<repo>/config.json).
 *
 * That file has multiple owners — repo-config.ts owns setup/clean/startScript/
 * open, lib/worktree/config.ts owns the "worktrees" key. This module reads the
 * SAME file but only ever looks at its "roles" and "intercepts" keys, and
 * never writes it.
 */

import { join } from "node:path";
import { readJson } from "../json-store.ts";
import { repoDataDir } from "../rt-paths.ts";

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

// ─── Raw file shape ──────────────────────────────────────────────────────────

interface RawRepoConfigFile {
  roles?: Record<string, unknown>;
  intercepts?: unknown[];
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
 * Reads the "roles" and "intercepts" keys of
 * ~/.mattstack/rt/repos/<repo>/config.json. Every other key in that file is
 * owned elsewhere; this never writes it. Missing file or malformed shapes
 * degrade to empty defaults rather than throwing.
 */
export function loadEndpointRepoConfig(repoName: string): EndpointRepoConfig {
  const path = join(repoDataDir(repoName), "config.json");
  const raw = readJson<RawRepoConfigFile>(path, {});
  return {
    roles: sanitizeRoles(raw.roles),
    intercepts: sanitizeIntercepts(raw.intercepts),
  };
}
