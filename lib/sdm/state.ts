/**
 * Recents persistence, in state.db's kv store (ns='sdm-state', k='state').
 * Guarded parse per the branch-cache pattern: a missing or malformed row
 * falls back to empty state rather than throwing.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { rtDir } from "../rt-paths.ts";
import {
  getKvValue,
  getStateDb,
  hasKvValue,
  importLegacyJsonFile,
  renameLegacyOutOfTheWay,
  setKvValue,
} from "../state/index.ts";

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

const SDM_STATE_NS = "sdm-state";
const SDM_STATE_KEY = "state";

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
export function sdmStatePath(): string {
  return join(rtDir(), "sdm", "state.json");
}

function normalizeState(raw: Partial<SdmState> | null | undefined): SdmState {
  return raw?.version === 1 && Array.isArray(raw.recents)
    ? { version: 1, recents: raw.recents as RecentEntry[] }
    : { version: 1, recents: [] };
}

export function loadSdmState(db: Database = getStateDb()): SdmState {
  if (hasKvValue(SDM_STATE_NS, SDM_STATE_KEY, db)) {
    return normalizeState(getKvValue<Partial<SdmState>>(SDM_STATE_NS, SDM_STATE_KEY, { version: 1, recents: [] }, db));
  }

  const result = importLegacyJsonFile<SdmState>(sdmStatePath(), (json) => {
    const state = normalizeState(json as Partial<SdmState> | null);
    setKvValue(SDM_STATE_NS, SDM_STATE_KEY, state, db);
    return state;
  });
  return result.imported ? result.value! : { version: 1, recents: [] };
}

export function saveSdmState(state: SdmState, db: Database = getStateDb()): void {
  setKvValue(SDM_STATE_NS, SDM_STATE_KEY, state, db);
  renameLegacyOutOfTheWay(sdmStatePath());
}

export function recordRecent(
  entry: Omit<RecentEntry, "lastConnectedAt">,
  opts: { db?: Database; now?: () => Date } = {},
): SdmState {
  const db = opts.db ?? getStateDb();
  const now = opts.now ?? (() => new Date());
  const state = loadSdmState(db);
  // Dedup by resource, not key: the key format changed across models, so an
  // old-format recent for the same resource must be replaced, not duplicated.
  const rest = state.recents.filter(r => r.sdmResource !== entry.sdmResource);
  const next: SdmState = {
    version: 1,
    recents: [{ ...entry, lastConnectedAt: now().toISOString() }, ...rest].slice(0, MAX_RECENTS),
  };
  saveSdmState(next, db);
  return next;
}
