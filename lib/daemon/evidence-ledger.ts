/**
 * Evidence ledger store -- flat JSON file at ~/.rt/evidence-ledger.json
 * tracking the state machine for evidence captures across requests.
 *
 * This module must not import from sync or handler modules, so it holds
 * no provider logic -- pure persistence.
 */

import { readFileSync, writeFileSync } from "fs";
import type { EvidenceSlot } from "../sandbox";
import { evidenceLedgerPath } from "../rt-paths";

export type LedgerState =
  | "requested"
  | "captured"
  | "synced"
  | "approved"
  | "rejected"
  | "attached"
  | "failed";

export interface EvidenceLedgerEntry {
  requestId: string;
  executor: "sidecar" | "local-chrome";
  sandboxId: string | null; // null for local-chrome entries
  repoId: string;
  branch: string;
  caseId: string;
  view: string;
  recipe: string;
  slot: EvidenceSlot;
  state: LedgerState;
  requestedAt: string;
  capturedAt?: string;
  syncedAt?: string;
  decidedAt?: string;
  attachedAt?: string;
  reason?: string; // reject reason, one line
  files?: { base: string; annotated?: string; manifest: string }; // absolute paths in the evidence tree
  error?: unknown; // typed error for failed
  redraws?: Array<{ at: string }>;
}

export interface EvidenceLedger {
  read(requestId: string): EvidenceLedgerEntry | undefined;
  upsert(entry: EvidenceLedgerEntry): void;
  list(
    filter?: {
      branch?: string;
      sandboxId?: string;
      states?: LedgerState[];
    }
  ): EvidenceLedgerEntry[];
  setState(
    requestId: string,
    state: LedgerState,
    patch?: Partial<EvidenceLedgerEntry>
  ): void;
  recordRedraw(requestId: string, at: string): void;
  flushNow(): void;
}

export function createEvidenceLedger(filePath: string = evidenceLedgerPath()): EvidenceLedger {
  let map: Record<string, EvidenceLedgerEntry> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      map = parsed;
  } catch {
    /* missing or corrupt -> cold start */
  }

  function flushNow(): void {
    try {
      writeFileSync(filePath, JSON.stringify(map, null, 2));
    } catch {
      /* write failure degrades to in-memory; next write retries */
    }
  }

  return {
    read: (requestId) => map[requestId],
    upsert: (entry) => {
      map[entry.requestId] = entry;
      flushNow();
    },
    list: (filter?) => {
      let entries = Object.values(map);

      if (filter?.branch) {
        entries = entries.filter((e) => e.branch === filter.branch);
      }
      if (filter?.sandboxId !== undefined) {
        entries = entries.filter((e) => e.sandboxId === filter.sandboxId);
      }
      if (filter?.states && filter.states.length > 0) {
        const stateSet = new Set(filter.states);
        entries = entries.filter((e) => stateSet.has(e.state));
      }

      // Sort by requestedAt
      entries.sort((a, b) =>
        new Date(a.requestedAt).getTime() -
        new Date(b.requestedAt).getTime()
      );

      return entries;
    },
    setState: (requestId, state, patch?) => {
      const entry = map[requestId];
      if (!entry) return;

      entry.state = state;

      // Stamp the matching timestamp field
      const now = new Date().toISOString();
      if (state === "captured") {
        entry.capturedAt = now;
      } else if (state === "synced") {
        entry.syncedAt = now;
      } else if (state === "approved" || state === "rejected") {
        entry.decidedAt = now;
      } else if (state === "attached") {
        entry.attachedAt = now;
      }

      // Merge the patch
      if (patch) {
        Object.assign(entry, patch);
      }

      flushNow();
    },
    recordRedraw: (requestId, at) => {
      const entry = map[requestId];
      if (!entry) return;

      if (!entry.redraws) {
        entry.redraws = [];
      }
      entry.redraws.push({ at });
      flushNow();
    },
    flushNow,
  };
}

let singleton: EvidenceLedger | null = null;
export function getEvidenceLedger(): EvidenceLedger {
  if (!singleton) singleton = createEvidenceLedger();
  return singleton;
}
