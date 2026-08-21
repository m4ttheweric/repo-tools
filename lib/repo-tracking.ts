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
 * repo NAME. Machine wins the whole entry per-repo whenever the RAW machine
 * map names that repo AT ALL — including an entry `normalizeEntry` rejects
 * (a typo'd mode, or an explicit `{mode:"off"}`) — not just when it produces
 * a valid grant: this is what makes `{mode:"off"}` a real local opt-out for
 * a team-tracked repo, and honors the same "a typo must never cause
 * accidental polling" rule for the team layer. An identity with no local
 * resolution is silently dropped (repo not cloned here). Resolution goes
 * through a primed identity→name map (see `primeTeamTrackingIdentityMap`)
 * rather than deriving live, because this loader runs synchronously on every
 * freshness tick while derivation shells out to git; an unprimed map means
 * team intent is inert, not an error.
 *
 * `loadMachineRepoTracking` is the machine-only half with no team merge —
 * the only function safe to read-modify-write through, and the only one a
 * grant gate that must not be unlockable by a shared team file may consult.
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

/** Valid, deduped cache names out of `value`; [] for a non-array or an all-bogus list. */
function keptCaches(value: unknown): CacheKind[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((c): c is CacheKind => typeof c === "string" && KINDS.has(c)))];
}

function normalizeEntry(value: unknown): RepoTrackingEntry | null {
  // Legacy flat string: "live" | "poll" ("off" meant delete-the-entry).
  if (typeof value === "string") {
    if (!MODES.has(value)) return null;
    return { mode: value as TrackingMode, caches: ["branches"] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { mode, caches } = value as { mode?: unknown; caches?: unknown };
  if (typeof mode !== "string" || !MODES.has(mode)) return null;
  const kept = keptCaches(caches);
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
 * intent, from the repo index (name → path) via `deriveRepoIdentity`. Called
 * from more than one site (daemon boot, the repos.json watch, the 60s
 * hooks-scan poller) — an overlap between two calls in flight at once is
 * harmless: both build from the same repo index and the last write wins, so
 * there's nothing to guard against races on.
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
  const kept = keptCaches(caches);
  if (kept.length === 0) return null;
  return { caches: kept };
}

// Dedupes the resolver-throw warning by message so a recurring per-tick
// failure logs once, not once per tick, while a genuinely new failure still
// surfaces. The machine-side equivalent below warns on every call instead —
// a deliberate asymmetry: it predates this dedupe and every caller/test
// depends on its exact per-call wording, so it's left alone rather than
// changed as a side effect of adding the team layer.
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

interface MachineTrackingRead {
  /** Normalized entries, keyed by repo name — what `loadMachineRepoTracking` returns. */
  out: RepoTracking;
  /** Every repo name present in the raw machine map, BEFORE normalization — a typo'd or
   *  `{mode:"off"}` entry still names its repo here even though it produced no `out` entry.
   *  This is the set `loadRepoTracking` gates team intent on, not `out`'s keys. */
  rawNames: Set<string>;
  /** Every repo name's RAW authored value, unnormalized — includes entries `out` drops
   *  (a typo'd mode, or an explicit `{mode:"off"}` opt-out marker). The only base a
   *  read-modify-write may rebuild the WHOLE map from without silently erasing one of
   *  those — see `loadMachineRepoTrackingRaw`/`saveRepoTrackingRaw`. */
  raw: Record<string, unknown>;
}

function readMachineTracking(): MachineTrackingRead {
  let rawValue: unknown;
  try {
    rawValue = getSetting<unknown>("rt.repoTracking").value;
  } catch (err) {
    console.warn(`rt: rt.repoTracking could not be resolved (${err instanceof Error ? err.message : err}) — tracking nothing`);
    return { out: {}, rawNames: new Set(), raw: {} };
  }

  const out: RepoTracking = {};
  const rawNames = new Set<string>();
  const raw: Record<string, unknown> = {};
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    let repos = rawValue as Record<string, unknown>;
    if (isVersionedEnvelope(repos)) {
      console.warn(
        "rt: rt.repoTracking holds a versioned {version, repos} envelope — store the repos map, not the versioned envelope " +
        "(e.g. `rt settings set rt.repoTracking` with just the inner repos object); using the inner repos map for now.",
      );
      repos = repos.repos;
    }
    for (const [repo, value] of Object.entries(repos)) {
      rawNames.add(repo);
      raw[repo] = value;
      const entry = normalizeEntry(value);
      if (entry) out[repo] = entry;
    }
  }
  return { out, rawNames, raw };
}

/**
 * Read the rt.repoTracking machine-store setting alone — no team merge. The
 * ONLY safe base for a read-modify-write (`rt daemon track`'s save path) and
 * the ONLY reader a grant gate that a shared team file must not be able to
 * unlock may consult (see `lib/daemon/handlers/secrets.ts`'s forge-token
 * gate). Absent/malformed setting, an unresolvable resolver value (e.g. an
 * unexpandable ${...} variable), unknown modes, and unknown cache names all
 * degrade toward "off" — a typo must never cause accidental polling, and
 * this loader runs on every freshness tick so it can never throw into the
 * daemon.
 */
export function loadMachineRepoTracking(): RepoTracking {
  return readMachineTracking().out;
}

/**
 * The raw machine map, unnormalized — every repo's authored value exactly as
 * stored, including entries `normalizeEntry` rejects (a typo'd mode, or an
 * explicit `{mode:"off"}` opt-out marker). `loadMachineRepoTracking()` drops
 * those, so a read-modify-write that rebuilds the WHOLE `rt.repoTracking`
 * value must start here instead, or it silently erases another repo's
 * off-marker (or any other raw value) the moment ANY repo's tracking is next
 * written — see `saveRepoTrackingRaw`, the companion writer.
 */
export function loadMachineRepoTrackingRaw(): Record<string, unknown> {
  return readMachineTracking().raw;
}

/**
 * Whether `mattstack.tracking`'s team-authored `repos` map names `identity`
 * at all — any value, valid or not. What `rt daemon track <repo> off` needs
 * before deciding whether turning a repo off can delete its machine grant
 * outright or must instead plant an explicit `{mode:"off"}` marker (see
 * `saveRepoTracking`'s `offMarkers` and the module doc's merge rule).
 */
export function teamNamesIdentity(identity: string): boolean {
  return Object.prototype.hasOwnProperty.call(loadTeamTracking(), identity);
}

/** Read the merged view (machine grants + team intent) — see the module doc for the merge rule. */
export function loadRepoTracking(opts?: { identityMap?: IdentityNameMap }): RepoTracking {
  const { out, rawNames } = readMachineTracking();

  const identityMap = opts?.identityMap ?? primedIdentityMap;
  if (Object.keys(identityMap).length > 0) {
    for (const [identity, value] of Object.entries(loadTeamTracking())) {
      const name = identityMap[identity];
      // Uncloned here, or the raw machine map already names this repo
      // (valid grant, typo, or explicit {mode:"off"} opt-out alike).
      if (!name || rawNames.has(name)) continue;
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

/**
 * Writes an already-assembled raw repo → value map to the machine store,
 * sorted for stable diffs. The companion to `loadMachineRepoTrackingRaw`: a
 * read-modify-write that must preserve an untouched repo's off-marker (or
 * any other raw value) starts from that raw map, mutates only the repo(s) it
 * means to change, and saves through here.
 */
export function saveRepoTrackingRaw(raw: Record<string, unknown>): void {
  const repos = Object.fromEntries(
    Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)),
  );
  setSetting("rt.repoTracking", repos, "machine");
}

/**
 * Writes the flat repo → entry map to the machine store, repos sorted for
 * stable diffs. NEVER pass a merged/primed read (`loadRepoTracking`'s
 * output) here — a caller doing read-modify-write must start from
 * `loadMachineRepoTracking()`, or every other repo's team-synthesized entry
 * gets baked into the machine store as if a human had granted it. This is a
 * fixture-convenience wrapper over `saveRepoTrackingRaw`: it only ever sees
 * NORMALIZED entries, so it is NOT safe for a read-modify-write that must
 * preserve an existing off-marker for some OTHER repo this write doesn't
 * touch — that needs `loadMachineRepoTrackingRaw`/`saveRepoTrackingRaw`
 * directly (see `commands/daemon.ts`'s `manageTracking`).
 *
 * `offMarkers` plants an explicit `{mode:"off"}` entry for each name listed —
 * `normalizeEntry` rejects that shape (mode "off" is not a valid grant), but
 * it still names the repo in the RAW machine map, which is what makes it a
 * real local opt-out for a repo the team layer still declares intent for
 * (module doc's merge rule: the raw machine map winning per-repo, not just a
 * valid grant winning). A name must not appear in both `tracking` and
 * `offMarkers` — the marker always wins ties, but callers should never rely
 * on that.
 */
export function saveRepoTracking(tracking: RepoTracking, offMarkers: string[] = []): void {
  const merged: Record<string, unknown> = { ...tracking };
  for (const name of offMarkers) merged[name] = { mode: "off" };
  saveRepoTrackingRaw(merged);
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
