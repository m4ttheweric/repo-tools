/**
 * Artifact sync: pulls a captured evidence request's files off the sandbox
 * and lands them in the branch-keyed evidence tree the human curates by
 * hand. Owns no fan-out logic itself (lib/sandbox-allocator.ts's `fanOut`
 * calls in here on `evidence-ready`) and never deletes anything under the
 * tree root -- only the human prunes it.
 *
 * The tree layout is `<evidenceRoot>/<branchSlug>/<caseId>/<slot>-<recipe>-
 * <requestId>{.png,.annotated.png,.json}`, matching treeFileNames below.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SandboxClient, EvidenceSlot } from "../sandbox.ts";
import { expandEvidenceRoot, type EvidenceConfig } from "../evidence-config.ts";
import type { EvidenceLedger, LedgerState } from "./evidence-ledger.ts";

export interface EvidenceSyncDeps {
  client: SandboxClient;
  ledger: EvidenceLedger;
  config(repoId: string): EvidenceConfig | null;
  notify(title: string, message: string, category: string): void; // same order as the allocator's SandboxSyncDeps.notify
}

/** "/" -> "-", lowercase, keep [a-z0-9._-]. */
export function branchSlug(branch: string): string {
  return branch
    .replace(/\//g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
}

export function treeFileNames(
  entry: { slot: EvidenceSlot; recipe: string; requestId: string },
): { base: string; annotated: string; manifest: string } {
  const stem = `${entry.slot}-${entry.recipe}-${entry.requestId}`;
  return { base: `${stem}.png`, annotated: `${stem}.annotated.png`, manifest: `${stem}.json` };
}

const SETTLED_STATES: ReadonlySet<LedgerState> = new Set(["synced", "approved", "rejected", "attached", "failed"]);

/** Every ledger entry for `branch` is settled, and at least one synced. */
export function batchReady(ledger: EvidenceLedger, branch: string): boolean {
  const entries = ledger.list({ branch });
  if (entries.length === 0) return false;
  let anySynced = false;
  for (const entry of entries) {
    if (!SETTLED_STATES.has(entry.state)) return false;
    if (entry.state === "synced") anySynced = true;
  }
  return anySynced;
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Idempotent, keyed by requestId: a missing or already-synced ledger entry
 * is a silent no-op (next poll or `rt evidence pull` may retry a capture
 * that hasn't landed yet). Quiet on success otherwise -- no per-capture
 * notification, only the batch-ready one below.
 */
export async function syncEvidence(deps: EvidenceSyncDeps, requestId: string): Promise<void> {
  const entry = deps.ledger.read(requestId);
  if (!entry || entry.state === "synced") return;

  const detail = await deps.client.getEvidence(requestId);
  if (!detail) return;

  const cfg = deps.config(entry.repoId);
  if (!cfg) return;

  const dir = join(expandEvidenceRoot(cfg.evidenceRoot), branchSlug(entry.branch), entry.caseId);
  mkdirSync(dir, { recursive: true });

  const names = treeFileNames({ slot: entry.slot, recipe: entry.recipe, requestId });

  const basePath = join(dir, names.base);
  writeFileSync(basePath, await deps.client.fetchEvidenceArtifact(requestId, "base.png"));

  const files: { base: string; annotated?: string; manifest: string } = {
    base: basePath,
    manifest: join(dir, names.manifest),
  };

  if (detail.artifacts.some(a => a.name === "annotated.png")) {
    const annotatedPath = join(dir, names.annotated);
    writeFileSync(annotatedPath, await deps.client.fetchEvidenceArtifact(requestId, "annotated.png"));
    files.annotated = annotatedPath;
  }

  const resultJson = decodeJson(await deps.client.fetchEvidenceArtifact(requestId, "result.json"));
  const manifest = {
    ...resultJson,
    sandboxId: entry.sandboxId,
    executor: "sidecar",
    syncedAt: new Date().toISOString(),
  };
  writeFileSync(files.manifest, JSON.stringify(manifest, null, 2));

  await deps.client.ackEvidenceSynced(requestId);
  deps.ledger.setState(requestId, "synced", { files });

  if (batchReady(deps.ledger, entry.branch)) {
    deps.notify("Evidence ready for review", `${entry.branch}: run rt evidence review`, "evidence_batch_ready");
  }
}
