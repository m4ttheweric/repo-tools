/**
 * Per-repo background-tracking grants — the ONE parser for
 * ~/.rt/repo-tracking.json, shared by the daemon (pure reader) and the CLI
 * (reader + writer). Spec: .local-dev/2026-07-26-typed-stores-board-rewire-design.md §4.
 *
 * v2 file shape:
 *   { "version": 2, "repos": { "<repo>": { "mode": "live"|"poll", "caches": [...] } } }
 *
 * `mode` is the freshness transport (live = events watcher + 5-min cycle,
 * poll = 5-min cycle only); `caches` is what that transport may maintain.
 * Unlisted repo = off. Nothing is granted implicitly. Legacy flat entries
 * ({ "<repo>": "live" }) are read as { mode, caches: ["branches"] } and
 * rewritten as v2 on the next save.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { RT_DIR } from "./daemon-config.ts";

export const REPO_TRACKING_PATH = join(RT_DIR, "repo-tracking.json");

export const CACHE_KINDS = ["branches", "project-mrs", "discussions"] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];
export type TrackingMode = "live" | "poll";

export interface RepoTrackingEntry { mode: TrackingMode; caches: CacheKind[]; }
export type RepoTracking = Record<string, RepoTrackingEntry>;
export interface RepoGrants { mode: TrackingMode | "off"; caches: Set<CacheKind>; }

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
  return { mode: mode as TrackingMode, caches: kept };
}

/**
 * Read the tracking file, accepting BOTH the v2 envelope and the legacy flat
 * map. Missing/corrupt file, unknown modes, and unknown cache names all
 * degrade toward "off" — a typo must never cause accidental polling.
 */
export function loadRepoTracking(filePath: string = REPO_TRACKING_PATH): RepoTracking {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {}; // missing file is the normal nothing-tracked state
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const repos = (parsed as { version?: unknown; repos?: unknown }).version === 2
    ? (parsed as { repos?: unknown }).repos
    : parsed;
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) return {};

  const out: RepoTracking = {};
  for (const [repo, value] of Object.entries(repos)) {
    if (repo === "version") continue; // tolerate a stray key in legacy shape
    const entry = normalizeEntry(value);
    if (entry) out[repo] = entry;
  }
  return out;
}

export function grants(tracking: RepoTracking, repoName: string): RepoGrants {
  const entry = tracking[repoName];
  if (!entry) return { mode: "off", caches: new Set() };
  return { mode: entry.mode, caches: new Set(entry.caches) };
}

/** Write the v2 envelope, repos sorted for stable diffs. */
export function saveRepoTracking(tracking: RepoTracking, filePath: string = REPO_TRACKING_PATH): void {
  const repos = Object.fromEntries(
    Object.entries(tracking).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(filePath, JSON.stringify({ version: 2, repos }, null, 2) + "\n");
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
