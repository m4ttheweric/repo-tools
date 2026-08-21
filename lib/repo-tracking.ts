/**
 * Per-repo background-tracking grants — the ONE parser for the rt.repoTracking
 * machine-store setting, shared by the daemon (pure reader) and the CLI
 * (reader + writer). Spec: .local-dev/2026-07-26-typed-stores-board-rewire-design.md §4.
 *
 * Value shape: a flat repo → entry map, { "<repo>": { "mode": "live"|"poll", "caches": [...] } }.
 *
 * `mode` is the freshness transport (live = events watcher + 5-min cycle,
 * poll = 5-min cycle only); `caches` is what that transport may maintain.
 * Unlisted repo = off. Nothing is granted implicitly. Legacy flat entries
 * ({ "<repo>": "live" }) are read as { mode, caches: ["branches"] } and
 * rewritten to the object shape on the next save.
 *
 * `loadRepoTracking` also folds in team-declared intent (`mattstack.tracking`,
 * team scope, IDENTITY-keyed: `{repos: {"<identity>": {caches:[...]}}}`) as
 * `{mode: "live", caches}` for any identity that resolves to a locally-known
 * repo NAME — machine wins the whole entry per-repo when one exists, and an
 * identity with no local resolution is silently dropped (repo not cloned
 * here). Resolution goes through a primed identity→name map (see
 * `primeTeamTrackingIdentityMap`) rather than deriving live, because this
 * loader runs synchronously on every freshness tick while derivation shells
 * out to git; an unprimed map means team intent is inert, not an error.
 */

import { getSetting } from "./settings/resolve.ts";
import { setSetting } from "./settings/write.ts";
import { deriveRepoIdentity } from "./settings/identity.ts";

export const CACHE_KINDS = ["branches", "project-mrs", "discussions"] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];
export type TrackingMode = "live" | "poll";

export const DEFAULT_PROJECT_MRS_WINDOW_DAYS = 30;

export interface RepoTrackingEntry { mode: TrackingMode; caches: CacheKind[]; projectMrsWindowDays?: number; }
export type RepoTracking = Record<string, RepoTrackingEntry>;
export interface RepoGrants { mode: TrackingMode | "off"; caches: Set<CacheKind>; projectMrsWindowDays: number; }

const MODES = new Set<string>(["live", "poll"]);
const KINDS = new Set<string>(CACHE_KINDS);

function normalizeEntry(value: unknown): RepoTrackingEntry | null {
  // Legacy flat string: "live" | "poll" ("off" meant delete-the-entry).
  if (typeof value === "string") {
    if (!MODES.has(value)) return null;
    return { mode: value as TrackingMode, caches: ["branches"] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { mode, caches } = value as { mode?: unknown; caches?: unknown };
  if (typeof mode !== "string" || !MODES.has(mode)) return null;
  if (!Array.isArray(caches)) return null;
  const kept = [...new Set(caches.filter((c): c is CacheKind => typeof c === "string" && KINDS.has(c)))];
  if (kept.length === 0) return null; // caches must be non-empty; a fully-bogus list degrades to off
  const { projectMrsWindowDays } = value as { projectMrsWindowDays?: unknown };
  const window = typeof projectMrsWindowDays === "number"
    && Number.isInteger(projectMrsWindowDays) && projectMrsWindowDays > 0
    ? projectMrsWindowDays : undefined;
  return { mode: mode as TrackingMode, caches: kept, ...(window !== undefined ? { projectMrsWindowDays: window } : {}) };
}

/**
 * A hand-authored (or freshly-imported) value still shaped like the old
 * on-disk file: `{ version: 2, repos: {...} }`. The settings key IS the
 * repos map now — the version wrapper is redundant — but silently
 * normalizing this to "nothing tracked" would look like every grant vanished
 * instead of naming the fixable mistake.
 */
function isVersionedEnvelope(value: Record<string, unknown>): value is { version: number; repos: Record<string, unknown> } {
  return typeof value.version === "number"
    && value.repos !== null && typeof value.repos === "object" && !Array.isArray(value.repos);
}

export type IdentityNameMap = Record<string, string>;

// Primed once (daemon boot) from the repo index, not derived per read —
// loadRepoTracking is sync and called on every freshness tick.
let primedIdentityMap: IdentityNameMap = {};

/**
 * Builds the identity→name map `loadRepoTracking` consults to resolve team
 * intent, from the repo index (name → path) via `deriveRepoIdentity`. Call
 * once at daemon boot (and again whenever the repo index changes); a repo
 * whose identity fails to derive is left out, not retried here.
 */
export async function primeTeamTrackingIdentityMap(repoIndex: Record<string, string>): Promise<void> {
  const map: IdentityNameMap = {};
  for (const [name, path] of Object.entries(repoIndex)) {
    const identity = await deriveRepoIdentity(path);
    if (identity) map[identity] = name;
  }
  primedIdentityMap = map;
}

function normalizeTeamEntry(value: unknown): { caches: CacheKind[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { caches } = value as { caches?: unknown };
  if (!Array.isArray(caches)) return null;
  const kept = [...new Set(caches.filter((c): c is CacheKind => typeof c === "string" && KINDS.has(c)))];
  if (kept.length === 0) return null;
  return { caches: kept };
}

// Dedupes the resolver-throw warning by message so a recurring per-tick
// failure logs once, not once per tick, while a genuinely new failure still
// surfaces.
let lastTeamTrackingWarning: string | null = null;

/** Reads mattstack.tracking's `repos` map; {} on absence, malformed shape, or resolver throw. */
function loadTeamTracking(): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = getSetting<unknown>("mattstack.tracking").value;
  } catch (err) {
    const message = `rt: mattstack.tracking could not be resolved (${err instanceof Error ? err.message : err}) — team tracking intent contributes nothing`;
    if (message !== lastTeamTrackingWarning) {
      lastTeamTrackingWarning = message;
      console.warn(message);
    }
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { repos } = raw as { repos?: unknown };
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) return {};
  return repos as Record<string, unknown>;
}

/**
 * Read the rt.repoTracking machine-store setting: a flat repo → entry map
 * (each entry either the v2 shape or a legacy flat string — see
 * normalizeEntry). Absent/malformed setting, an unresolvable resolver value
 * (e.g. an unexpandable ${...} variable), unknown modes, and unknown cache
 * names all degrade toward "off" — a typo must never cause accidental
 * polling, and this loader runs on every freshness tick so it can never
 * throw into the daemon.
 */
export function loadRepoTracking(opts?: { identityMap?: IdentityNameMap }): RepoTracking {
  let raw: unknown;
  try {
    raw = getSetting<unknown>("rt.repoTracking").value;
  } catch (err) {
    console.warn(`rt: rt.repoTracking could not be resolved (${err instanceof Error ? err.message : err}) — tracking nothing`);
    return {};
  }

  const out: RepoTracking = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    let repos = raw as Record<string, unknown>;
    if (isVersionedEnvelope(repos)) {
      console.warn(
        "rt: rt.repoTracking holds a versioned {version, repos} envelope — store the repos map, not the versioned envelope " +
        "(e.g. `rt settings set rt.repoTracking` with just the inner repos object); using the inner repos map for now.",
      );
      repos = repos.repos;
    }
    for (const [repo, value] of Object.entries(repos)) {
      const entry = normalizeEntry(value);
      if (entry) out[repo] = entry;
    }
  }

  const identityMap = opts?.identityMap ?? primedIdentityMap;
  if (Object.keys(identityMap).length > 0) {
    for (const [identity, value] of Object.entries(loadTeamTracking())) {
      const name = identityMap[identity];
      if (!name || out[name]) continue; // uncloned here, or machine wins the whole entry
      const entry = normalizeTeamEntry(value);
      if (entry) out[name] = { mode: "live", caches: entry.caches };
    }
  }

  return out;
}

export function grants(tracking: RepoTracking, repoName: string): RepoGrants {
  const entry = tracking[repoName];
  if (!entry) return { mode: "off", caches: new Set(), projectMrsWindowDays: DEFAULT_PROJECT_MRS_WINDOW_DAYS };
  return { mode: entry.mode, caches: new Set(entry.caches),
    projectMrsWindowDays: entry.projectMrsWindowDays ?? DEFAULT_PROJECT_MRS_WINDOW_DAYS };
}

/** Writes the flat repo → entry map to the machine store, repos sorted for stable diffs. */
export function saveRepoTracking(tracking: RepoTracking): void {
  const repos = Object.fromEntries(
    Object.entries(tracking).sort(([a], [b]) => a.localeCompare(b)),
  );
  setSetting("rt.repoTracking", repos, "machine");
}

/** "branches, project-mrs" → kinds. Null on empty input or any unknown name. */
export function parseCachesArg(raw: string): CacheKind[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const out: CacheKind[] = [];
  for (const p of parts) {
    if (!KINDS.has(p)) return null;
    if (!out.includes(p as CacheKind)) out.push(p as CacheKind);
  }
  return out;
}
