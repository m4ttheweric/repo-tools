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
 */

import { getSetting } from "./settings/resolve.ts";
import { setSetting } from "./settings/write.ts";

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
 * Read the rt.repoTracking machine-store setting: a flat repo → entry map
 * (each entry either the v2 shape or a legacy flat string — see
 * normalizeEntry). Absent/malformed setting, unknown modes, and unknown
 * cache names all degrade toward "off" — a typo must never cause accidental
 * polling.
 */
export function loadRepoTracking(): RepoTracking {
  const raw = getSetting<unknown>("rt.repoTracking").value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const out: RepoTracking = {};
  for (const [repo, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = normalizeEntry(value);
    if (entry) out[repo] = entry;
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
