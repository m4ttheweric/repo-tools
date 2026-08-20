/**
 * The settings resolver (RT-47): one read path that layers the four stores,
 * the legacy per-repo file and the registry default into a single answer plus
 * the provenance that explains it.
 *
 * Scope ladder, weakest → strongest:
 *
 *   default < legacy < team < user < team.repo < user.repo < machine < machine.repo
 *
 * `legacy` is the pre-migration per-tool file for a key (wave 1: the three
 * `repos/<name>/config.json` keys). It beats the registry default and loses to
 * every authored store, and it carries real provenance so migration progress is
 * observable rather than folklore.
 *
 * Merge is per-key schema, never global (`SettingDef.merge`):
 *  - `replace` — the strongest valid scope wins atomically; provenance has
 *    exactly one entry.
 *  - `deep` — object values overlay field-by-field walking weakest → strongest;
 *    arrays and scalars inside a deep key still replace atomically. Provenance
 *    lists every scope that still owns at least one leaf of the resolved value,
 *    weakest-first — a scope whose every field was overridden is NOT listed
 *    (same honesty rule that makes `replace` provenance length 1).
 *
 * Degrade rules (teammates run version-skewed binaries; one unknown key in the
 * team store must never brick resolution):
 *  - explicit `get`/`explain` of an unregistered key → throw.
 *  - unregistered keys FOUND in files → warn + skip, surfaced by `listSettings`
 *    with `unregistered: true`.
 *  - a registered key whose found value fails validation → warn + skip THAT
 *    scope only, labeled `invalid` in list/explain; weaker and stronger scopes
 *    still apply.
 *
 * Three deliberate decisions this file makes that the spec left to the
 * implementation:
 *  1. **The path-literal guard is scope-aware.** `validateValue`'s guarded
 *     fields (`rt.roles.hook`) are only illegal in SHARED scopes. The machine
 *     store is explicitly allowed path literals, and the legacy per-repo file
 *     is full of them today — guarding those would reject exactly the values
 *     wave 1 has to keep reading. So team/user rungs get the full check,
 *     machine/legacy rungs get the type check alone.
 *  2. **A value found in a store the def does not allow is skipped**, labeled
 *     like any other invalid value (`rt.repoIdentityOverrides` is machine-only;
 *     honouring a team-store copy of it would defeat the schema).
 *  3. **`explain` shows values AS AUTHORED** (never expanded) because its job
 *     is to say what is in which file, and **`list` degrades** an unexpandable
 *     value to its raw form with an `expandError` label rather than throwing —
 *     one bad value must not brick a survey of every key. `get` is the loud
 *     one: an unsatisfiable closed-set variable throws.
 *
 * The resolver is daemon-FREE and sync: no spawns anywhere, repo identity is a
 * pre-derived input (see identity.ts for the async derivation). Store files are
 * parsed fresh per call — they are small, and memoization is a later
 * optimization that would need invalidation this wave does not have.
 *
 * Writes (`setSetting`) land in a later task; this module is read-side only.
 */

import { homedir } from "os";
import { join } from "path";
import { readJson } from "../json-store.ts";
import {
  machineSettingsPath,
  repoDataDir,
  teamSettingsPath,
  teamsDir,
  userSettingsPath,
} from "../rt-paths.ts";
import { allDefs, getDef, validateValue, type SettingDef, type SettingScope } from "./registry.ts";
import { listTeams, readStore, type StoreFile } from "./stores.ts";

// ─── Public types ────────────────────────────────────────────────────────────

export type Scope =
  | "machine.repo"
  | "machine"
  | "user.repo"
  | "team.repo"
  | "user"
  | "team"
  | "legacy"
  | "default";

/** The scope ladder, weakest first. Also the order every result is built in. */
export const SCOPE_ORDER: Scope[] = [
  "default",
  "legacy",
  "team",
  "user",
  "team.repo",
  "user.repo",
  "machine",
  "machine.repo",
];

export interface Provenance {
  scope: Scope;
  /** The file the value came from; null for the registry default. */
  file: string | null;
}

export interface ResolveOpts {
  /** Normalized repo identity (identity.ts). Null/absent = repo rungs are unreachable. */
  repoIdentity?: string | null;
  /** Expand closed-set variables in the resolved value. Default true. */
  expand?: boolean;
  expandCtx?: { repoRoot?: string; worktree?: string };
  /** Supplying a repoName enables the legacy rung for keys the reader maps. */
  legacy?: { repoName?: string };
}

export interface Resolved<T> {
  value: T;
  /** ALWAYS an array, weakest-first. Length 1 for replace keys. */
  provenance: Provenance[];
}

/** A scope whose authored value was found but refused (type, path guard, or store). */
export interface InvalidScope {
  scope: Scope;
  file: string | null;
  reason: string;
}

export interface ListedSetting {
  key: string;
  value: unknown;
  provenance: Provenance[];
  migrated: boolean;
  /** Present only for keys found in files but absent from the registry. */
  unregistered?: true;
  /** Scopes skipped during resolution, with the reason each was refused. */
  invalid?: InvalidScope[];
  /** Set when the value could not be expanded here; `value` is then raw. */
  expandError?: string;
}

export interface ExplainRow {
  scope: Scope;
  file: string | null;
  present: boolean;
  /** The value AS AUTHORED — never variable-expanded. */
  value?: unknown;
  /** Set when the value was ignored because the key is teamLocked. */
  shadowed?: "teamLocked";
  /** Set when the value was refused; the reason it was refused. */
  invalid?: string;
}

export interface ExpandCtx {
  repoRoot?: string;
  worktree?: string;
  home: string;
  teamsDir: string;
}

// ─── The legacy rung ─────────────────────────────────────────────────────────

export interface LegacyReader {
  (key: string, repoName: string): unknown | undefined;
}

/**
 * The three wave-1 keys and the `repos/<name>/config.json` field each one used
 * to live in. A key that is not in this map has no legacy rung.
 */
const LEGACY_KEY_MAP: Record<string, string> = {
  "rt.roles": "roles",
  "rt.intercepts": "intercepts",
  "rt.worktrees": "worktrees",
};

function legacyFilePath(repoName: string): string {
  return join(repoDataDir(repoName), "config.json");
}

/**
 * The shipped legacy reader: the named key's field out of the per-repo
 * config.json. `readJson` already degrades a missing or malformed file to the
 * fallback, which is exactly the "no legacy value" answer we want.
 */
export const defaultLegacyReader: LegacyReader = (key, repoName) => {
  const field = LEGACY_KEY_MAP[key];
  if (field === undefined) return undefined;
  const raw = readJson<Record<string, unknown>>(legacyFilePath(repoName), {});
  return raw[field];
};

let legacyReader: LegacyReader = defaultLegacyReader;

/**
 * TEST SEAM ONLY. Production code uses the shipped reader; pass
 * `defaultLegacyReader` back to restore it.
 */
export function setLegacyReader(fn: LegacyReader): void {
  legacyReader = fn;
}

// ─── Variables ───────────────────────────────────────────────────────────────

const VAR_RE = /\$\{([^}]*)\}/g;
const TEAM_VAR_RE = /^team:(.+)$/;

/**
 * Replaces ONLY `${repoRoot}`, `${worktree}`, `${home}` and `${team:<name>}`.
 * Every other `${...}` passes through verbatim — domain templates like the
 * interceptor's `${port}` are not ours to expand, and the same string may hold
 * both kinds, so substitution is per-occurrence. `${team:<name>}` is lexical:
 * `<teamsDir>/<name>` with no existence check (a missing team surfaces at use
 * time through the consumer's own fail-open path), but the name must be a
 * single directory segment — see `teamPath`. A closed-set variable with no
 * context in `ctx` throws — silently emitting a half-expanded path is the
 * dishonesty this design bans.
 *
 * Recurses through arrays and plain objects; non-strings pass through. Never
 * mutates its input.
 */
export function expandVariables(value: unknown, ctx: ExpandCtx): unknown {
  if (typeof value === "string") return expandString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => expandVariables(item, ctx));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandVariables(v, ctx);
    return out;
  }
  return value;
}

function expandString(input: string, ctx: ExpandCtx): string {
  return input.replace(VAR_RE, (match, name: string) => {
    if (name === "home") return ctx.home;
    if (name === "repoRoot") return required(ctx.repoRoot, "repoRoot", "a repo path");
    if (name === "worktree") return required(ctx.worktree, "worktree", "a worktree path");
    const team = TEAM_VAR_RE.exec(name);
    if (team) return teamPath(ctx.teamsDir, team[1] as string);
    return match; // not ours — pass through verbatim
  });
}

/**
 * `${team:<name>}` → `<teamsDir>/<name>`, but only for a name that is a single
 * directory segment. `<name>` is a team NAME, and `join()` normalizes away
 * `..`, so `${team:../../.ssh}` would quietly resolve to a path OUTSIDE the
 * teams dir — a store value (a team store's own, even) that reads or executes
 * from anywhere on disk while still looking like a team-relative reference.
 * Any `/`, `\` or `..` therefore throws, on the same closed-set footing as an
 * unsatisfiable `${repoRoot}`: `get` surfaces it, `list` degrades that one
 * value to an `expandError`, and no half-expanded path is ever emitted.
 */
function teamPath(teamsDir: string, name: string): string {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(
      `rt: cannot expand \${team:${name}} — a team name must be a single directory segment (no "/", "\\" or "..")`,
    );
  }
  return join(teamsDir, name);
}

function required(value: string | undefined, name: string, needs: string): string {
  if (value === undefined || value === "") {
    throw new Error(`rt: cannot expand \${${name}} — this setting was resolved without ${needs}`);
  }
  return value;
}

// ─── Store reading ───────────────────────────────────────────────────────────

interface StoreBundle {
  user: StoreFile;
  machine: StoreFile;
  /** One per team that has a local settings file, alphabetical (wave 1: overlay all). */
  teams: StoreFile[];
}

function readStores(): StoreBundle {
  return {
    user: readStore(userSettingsPath()),
    machine: readStore(machineSettingsPath()),
    teams: [...listTeams()].sort().map((team) => readStore(teamSettingsPath(team))),
  };
}

// ─── Slots: every rung a key could come from, weakest-first ──────────────────

interface Slot {
  scope: Scope;
  file: string | null;
  present: boolean;
  value?: unknown;
}

function collectSlots(def: SettingDef, stores: StoreBundle, opts: ResolveOpts): Slot[] {
  const slots: Slot[] = [];
  const identity = opts.repoIdentity ?? null;
  const useRepo = def.repoScoped === true && typeof identity === "string" && identity !== "";
  const repoSection = (store: StoreFile): Record<string, unknown> | undefined =>
    useRepo ? store.repos[identity as string] : undefined;

  const push = (scope: Scope, file: string | null, section: Record<string, unknown> | undefined) => {
    const value = section?.[def.key];
    if (value === undefined) slots.push({ scope, file, present: false });
    else slots.push({ scope, file, present: true, value });
  };

  /**
   * Wave 1 overlays EVERY cloned team, alphabetically, so the result is
   * deterministic; multi-team precedence is explicitly deferred (spec: out of
   * scope — one team exists today). With no team cloned at all we still emit
   * one absent rung so `explain` shows the ladder in full.
   */
  const pushTeams = (scope: Scope, section: (store: StoreFile) => Record<string, unknown> | undefined) => {
    if (stores.teams.length === 0) {
      slots.push({ scope, file: null, present: false });
      return;
    }
    for (const store of stores.teams) push(scope, store.file, section(store));
  };

  // default — cloned so a caller mutating the resolved value cannot corrupt
  // the registry's shared def object.
  slots.push(
    def.default === undefined
      ? { scope: "default", file: null, present: false }
      : { scope: "default", file: null, present: true, value: structuredClone(def.default) },
  );

  // legacy — only reachable when the caller supplies the repo NAME (repos.json
  // is the name→path registry; the name/identity bridge is the caller's job).
  const repoName = opts.legacy?.repoName;
  if (repoName) {
    const value = legacyReader(def.key, repoName);
    const file = legacyFilePath(repoName);
    slots.push(
      value === undefined
        ? { scope: "legacy", file, present: false }
        : { scope: "legacy", file, present: true, value },
    );
  } else {
    slots.push({ scope: "legacy", file: null, present: false });
  }

  // The ladder itself, weakest → strongest. Repo rungs are omitted entirely
  // when they are unreachable (key not repoScoped, or no identity in hand) —
  // an unreachable rung in `explain` would be noise, not honesty.
  pushTeams("team", (store) => store.global);
  push("user", stores.user.file, stores.user.global);
  if (useRepo) pushTeams("team.repo", repoSection);
  if (useRepo) push("user.repo", stores.user.file, repoSection(stores.user));
  push("machine", stores.machine.file, stores.machine.global);
  if (useRepo) push("machine.repo", stores.machine.file, repoSection(stores.machine));

  return slots;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

interface Resolution {
  value: unknown;
  provenance: Provenance[];
  invalid: InvalidScope[];
  rows: ExplainRow[];
}

const TEAM_LOCKED_SCOPES: Scope[] = ["default", "team", "team.repo"];

/** The store a scope's value is authored in — the rung's write-side scope. */
function baseScope(scope: Scope): SettingScope | null {
  if (scope === "team" || scope === "team.repo") return "team";
  if (scope === "user" || scope === "user.repo") return "user";
  if (scope === "machine" || scope === "machine.repo") return "machine";
  return null; // default and legacy are not authored in a store
}

/**
 * The path-literal guard applies to SHARED scopes only — the machine store is
 * the one place path literals are legal, and the legacy per-repo file is full
 * of them today.
 */
function validateForScope(
  def: SettingDef,
  scope: Scope,
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  const shared = scope === "team" || scope === "user" || scope === "team.repo" || scope === "user.repo";
  return validateValue(shared ? def : { ...def, pathGuardFields: undefined }, value);
}

function resolveDef(def: SettingDef, stores: StoreBundle, opts: ResolveOpts): Resolution {
  const slots = collectSlots(def, stores, opts);
  const rows: ExplainRow[] = [];
  const invalid: InvalidScope[] = [];
  const applied: Array<{ scope: Scope; file: string | null; value: unknown }> = [];

  for (const slot of slots) {
    const row: ExplainRow = { scope: slot.scope, file: slot.file, present: slot.present };
    if (!slot.present) {
      rows.push(row);
      continue;
    }
    row.value = slot.value;

    // teamLocked: team.repo > team > default and nothing else. Other scopes'
    // values are reported, never applied.
    if (def.teamLocked && !TEAM_LOCKED_SCOPES.includes(slot.scope)) {
      row.shadowed = "teamLocked";
      rows.push(row);
      continue;
    }

    // A key authored in a store its def does not list is not this key.
    const base = baseScope(slot.scope);
    if (base !== null && !def.scopes.includes(base)) {
      const reason = `not settable in the ${base} store (allowed: ${def.scopes.join(", ")})`;
      row.invalid = reason;
      invalid.push({ scope: slot.scope, file: slot.file, reason });
      rows.push(row);
      continue;
    }

    // The registry default is trusted; everything read off disk is checked.
    if (slot.scope !== "default") {
      const check = validateForScope(def, slot.scope, slot.value);
      if (!check.ok) {
        row.invalid = check.reason;
        invalid.push({ scope: slot.scope, file: slot.file, reason: check.reason });
        rows.push(row);
        continue;
      }
    }

    rows.push(row);
    applied.push({ scope: slot.scope, file: slot.file, value: slot.value });
  }

  const merged = mergeApplied(def, applied);
  return { value: merged.value, provenance: merged.provenance, invalid, rows };
}

function mergeApplied(
  def: SettingDef,
  applied: Array<{ scope: Scope; file: string | null; value: unknown }>,
): { value: unknown; provenance: Provenance[] } {
  if (applied.length === 0) return { value: undefined, provenance: [] };

  // Deep merge is only meaningful for objects; a `deep` def with any other
  // type — or a non-object layer, only reachable through a malformed registry
  // default since every value read off disk is type-checked — falls back to
  // replace rather than inventing semantics for it.
  if (def.merge === "deep" && def.type === "object") {
    const objectLayers = applied.filter((layer) => isPlainObject(layer.value));
    if (objectLayers.length > 0) {
      const { value, contributors } = deepMerge(objectLayers.map((layer) => layer.value));
      return {
        value,
        provenance: contributors.map((i) => {
          const layer = objectLayers[i] as (typeof applied)[number];
          return { scope: layer.scope, file: layer.file };
        }),
      };
    }
  }

  const winner = applied[applied.length - 1] as (typeof applied)[number];
  return { value: winner.value, provenance: [{ scope: winner.scope, file: winner.file }] };
}

// ─── Deep merge with per-leaf attribution ────────────────────────────────────

// Leaf paths are joined with NUL so a field name containing a dot cannot
// collide with a nested path of the same spelling.
const PATH_SEP = "\u0000";

/**
 * Overlays object layers weakest → strongest, tracking which layer owns each
 * surviving leaf. Arrays and scalars replace atomically (an array IS a leaf);
 * objects recurse. `contributors` is the ascending list of layer indexes that
 * still own at least one leaf of the result.
 */
function deepMerge(layers: unknown[]): { value: Record<string, unknown>; contributors: number[] } {
  const owner = new Map<string, number>();
  let acc: Record<string, unknown> = {};

  layers.forEach((layer, index) => {
    acc = overlay(acc, layer as Record<string, unknown>, owner, index, "");
  });

  const contributors = [...new Set(owner.values())].sort((a, b) => a - b);
  return { value: acc, contributors };
}

function overlay(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  owner: Map<string, number>,
  index: number,
  prefix: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(over)) {
    const path = prefix === "" ? key : `${prefix}${PATH_SEP}${key}`;
    const current = out[key];

    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = overlay(current, value, owner, index, path);
      continue;
    }

    out[key] = value;
    clearOwners(owner, path);
    registerLeaves(value, path, owner, index);
  }

  return out;
}

function clearOwners(owner: Map<string, number>, path: string): void {
  owner.delete(path);
  const under = `${path}${PATH_SEP}`;
  for (const existing of [...owner.keys()]) {
    if (existing.startsWith(under)) owner.delete(existing);
  }
}

/**
 * Records ownership at LEAF granularity: an object is walked into so that a
 * stronger layer overriding every one of its fields takes the whole thing over
 * (and the weaker layer correctly drops out of provenance).
 */
function registerLeaves(value: unknown, path: string, owner: Map<string, number>, index: number): void {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      for (const [key, child] of entries) {
        registerLeaves(child, `${path}${PATH_SEP}${key}`, owner, index);
      }
      return;
    }
  }
  owner.set(path, index);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ─── Public API ──────────────────────────────────────────────────────────────

function unknownKey(key: string): Error {
  return new Error(`rt: unknown setting "${key}" — not in the settings registry (see \`rt settings list\`)`);
}

function expandCtxFrom(opts: ResolveOpts): ExpandCtx {
  return {
    repoRoot: opts.expandCtx?.repoRoot,
    worktree: opts.expandCtx?.worktree,
    home: process.env.HOME ?? homedir(),
    teamsDir: teamsDir(),
  };
}

function warnInvalid(key: string, entry: InvalidScope): void {
  console.warn(
    `rt: ignoring "${key}" from the ${entry.scope} scope (${entry.file ?? "no file"}): ${entry.reason}`,
  );
}

/**
 * Resolves one key across the whole ladder. Throws for an unregistered key —
 * an explicit get of something rt has never heard of is a caller bug, not a
 * degrade (contrast: unknown keys FOUND in files, which only warn).
 */
export function getSetting<T>(key: string, opts: ResolveOpts = {}): Resolved<T> {
  const def = getDef(key);
  if (!def) throw unknownKey(key);

  const resolution = resolveDef(def, readStores(), opts);
  for (const entry of resolution.invalid) warnInvalid(key, entry);

  const shouldExpand = opts.expand ?? true;
  const value =
    shouldExpand && resolution.value !== undefined
      ? expandVariables(resolution.value, expandCtxFrom(opts))
      : resolution.value;

  return { value: value as T, provenance: resolution.provenance };
}

/**
 * Every registered key resolved (registry order), then every unregistered key
 * found in the stores (alphabetical). Nothing here throws: a survey of the
 * whole settings map must survive one bad value, so an unexpandable value
 * degrades to its raw form plus an `expandError` label.
 */
export function listSettings(opts: ResolveOpts = {}): ListedSetting[] {
  const stores = readStores();
  const ctx = expandCtxFrom(opts);
  const shouldExpand = opts.expand ?? true;
  const out: ListedSetting[] = [];

  for (const def of allDefs()) {
    const resolution = resolveDef(def, stores, opts);
    for (const entry of resolution.invalid) warnInvalid(def.key, entry);

    const listed: ListedSetting = {
      key: def.key,
      value: resolution.value,
      provenance: resolution.provenance,
      migrated: def.migrated,
    };
    if (resolution.invalid.length > 0) listed.invalid = resolution.invalid;

    if (shouldExpand && resolution.value !== undefined) {
      try {
        listed.value = expandVariables(resolution.value, ctx);
      } catch (err) {
        listed.expandError = (err as Error).message;
        console.warn(`rt: showing "${def.key}" unexpanded — ${listed.expandError}`);
      }
    }

    out.push(listed);
  }

  out.push(...listUnregistered(stores, opts));
  return out;
}

/**
 * Keys present in a store file that the registry has never heard of. They are
 * never merged (there is no def to say how) — the strongest scope holding one
 * is reported as-is, so a teammate's newer key is visible rather than silently
 * dropped.
 */
function listUnregistered(stores: StoreBundle, opts: ResolveOpts): ListedSetting[] {
  const identity = opts.repoIdentity ?? null;
  const found = new Map<string, Provenance & { value: unknown }>();

  const scan = (scope: Scope, file: string, section: Record<string, unknown> | undefined) => {
    for (const [key, value] of Object.entries(section ?? {})) {
      if (getDef(key)) continue;
      found.set(key, { scope, file, value }); // later (stronger) scans win
    }
  };
  const repoSection = (store: StoreFile) =>
    typeof identity === "string" && identity !== "" ? store.repos[identity] : undefined;

  for (const store of stores.teams) scan("team", store.file, store.global);
  scan("user", stores.user.file, stores.user.global);
  for (const store of stores.teams) scan("team.repo", store.file, repoSection(store));
  scan("user.repo", stores.user.file, repoSection(stores.user));
  scan("machine", stores.machine.file, stores.machine.global);
  scan("machine.repo", stores.machine.file, repoSection(stores.machine));

  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, hit]) => {
      console.warn(
        `rt: unregistered setting "${key}" in ${hit.file} — ignoring it (this rt may be older than the store)`,
      );
      return {
        key,
        value: hit.value,
        provenance: [{ scope: hit.scope, file: hit.file }],
        migrated: false,
        unregistered: true as const,
      };
    });
}

/**
 * One row per reachable rung, weakest-first, with values AS AUTHORED. Repo
 * rungs are omitted entirely when the key is not repoScoped or no identity was
 * supplied — showing rungs that could never apply would be noise, not honesty.
 */
export function explainSetting(key: string, opts: ResolveOpts = {}): ExplainRow[] {
  const def = getDef(key);
  if (!def) throw unknownKey(key);
  return resolveDef(def, readStores(), opts).rows;
}
