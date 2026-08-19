/**
 * Recents persistence (~/.mattstack/rt/sdm/state.json). Guarded parse per the
 * branch-cache pattern: a missing or corrupt file falls back to empty
 * state rather than throwing.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { rtDir } from "../rt-paths.ts";
import { dirname, join } from "node:path";

export interface RecentEntry {
  key: string;
  label: string;
  sdmResource: string;
  tier?: string;
  production?: boolean;
  reasonSuggestion?: string;
  db?: { database?: string; schema?: string; user?: string };
  lastConnectedAt: string;
}

export interface SdmState {
  version: 1;
  recents: RecentEntry[];
}

export const MAX_RECENTS = 10;

export function sdmStatePath(): string {
  return join(rtDir(), "sdm", "state.json");
}

export function loadSdmState(path = sdmStatePath()): SdmState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.recents)) {
      return { version: 1, recents: parsed.recents };
    }
  } catch {
    // Missing or corrupt state falls back to empty; recents are best-effort.
  }
  return { version: 1, recents: [] };
}

export function saveSdmState(state: SdmState, path = sdmStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function recordRecent(
  entry: Omit<RecentEntry, "lastConnectedAt">,
  opts: { path?: string; now?: () => Date } = {},
): SdmState {
  const path = opts.path ?? sdmStatePath();
  const now = opts.now ?? (() => new Date());
  const state = loadSdmState(path);
  // Dedup by resource, not key: the key format changed across models, so an
  // old-format recent for the same resource must be replaced, not duplicated.
  const rest = state.recents.filter(r => r.sdmResource !== entry.sdmResource);
  const next: SdmState = {
    version: 1,
    recents: [{ ...entry, lastConnectedAt: now().toISOString() }, ...rest].slice(0, MAX_RECENTS),
  };
  saveSdmState(next, path);
  return next;
}
