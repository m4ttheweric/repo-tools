import { describe, test, expect } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceLedger } from "../evidence-ledger.ts";
import type { EvidenceLedgerEntry } from "../evidence-ledger.ts";
import type { SandboxClient } from "../../sandbox.ts";
import type { EvidenceLogin } from "../../evidence-config.ts";
import {
  branchSlug,
  treeFileNames,
  syncEvidence,
  batchReady,
  type EvidenceSyncDeps,
} from "../evidence-sync.ts";

const ENTRY: EvidenceLedgerEntry = {
  requestId: "r1",
  executor: "sidecar",
  sandboxId: "sb1",
  repoId: "demo",
  branch: "acme-1-fix",
  caseId: "c1",
  view: "v",
  recipe: "rec",
  slot: "after",
  state: "requested",
  requestedAt: "2026-08-08T00:00:00.000Z",
};

const LOGIN_FIXTURE: EvidenceLogin = { url: "/", fields: {}, submit: "b", assertAuthed: { selector: "[x]" } };

function syncSetup() {
  const treeRoot = mkdtempSync(join(tmpdir(), "rt-tree-"));
  const ledger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-evl-")), "l.json"));
  ledger.upsert({ ...ENTRY, state: "captured" }); // ENTRY as in the ledger tests
  const acked: string[] = [];
  const client = {
    getEvidence: async (id: string) => ({
      ...ENTRY, id, artifacts: [{ name: "base.png", size: 2 }, { name: "annotated.png", size: 2 }, { name: "result.json", size: 10 }],
    }),
    fetchEvidenceArtifact: async (_id: string, name: string) =>
      name === "result.json" ? new TextEncoder().encode('{"ok":true}') : new Uint8Array([7, 7]),
    ackEvidenceSynced: async (id: string) => { acked.push(id); },
  } as unknown as SandboxClient;
  const notes: string[] = [];
  const deps: EvidenceSyncDeps = {
    client, ledger,
    config: () => ({ evidenceRoot: treeRoot, appPort: 4001, views: {}, recipes: {}, login: LOGIN_FIXTURE }),
    notify: (title, _message, category) => notes.push(`${category}:${title}`),
  };
  return { deps, ledger, treeRoot, acked, notes };
}

describe("branchSlug", () => {
  test("slashes become dashes, lowercased, non [a-z0-9._-] stripped", () => {
    expect(branchSlug("acme-1-fix")).toBe("acme-1-fix");
    expect(branchSlug("Feature/ACME-42")).toBe("feature-acme-42");
    expect(branchSlug("weird branch!name")).toBe("weirdbranchname");
  });
});

describe("treeFileNames", () => {
  test("builds slot-recipe-requestId stems", () => {
    expect(treeFileNames({ slot: "after", recipe: "rec", requestId: "r1" })).toEqual({
      base: "after-rec-r1.png",
      annotated: "after-rec-r1.annotated.png",
      manifest: "after-rec-r1.json",
    });
  });
});

describe("syncEvidence", () => {
  test("happy sync writes the three tree files, acks, marks synced; second call no-ops", async () => {
    const { deps, ledger, treeRoot, acked } = syncSetup();
    await syncEvidence(deps, "r1");
    const dir = join(treeRoot, "acme-1-fix", "c1");
    expect(readdirSync(dir).sort()).toEqual([
      "after-rec-r1.annotated.png", "after-rec-r1.json", "after-rec-r1.png",
    ]);
    expect(acked).toEqual(["r1"]);
    expect(ledger.read("r1")!.state).toBe("synced");
    expect(ledger.read("r1")!.files!.base).toBe(join(dir, "after-rec-r1.png"));
    await syncEvidence(deps, "r1");
    expect(acked).toEqual(["r1"]); // idempotent
  });

  test("batch-ready notifies exactly when the branch's last unsettled entry syncs", async () => {
    const { deps, ledger, notes } = syncSetup();
    ledger.upsert({ ...ENTRY, requestId: "r2", state: "requested" }); // same branch, still open
    await syncEvidence(deps, "r1");
    expect(notes).toEqual([]);
    ledger.setState("r2", "failed");
    ledger.setState("r1", "captured"); // re-arm r1 so a second sync exercises the check
    await syncEvidence(deps, "r1");
    expect(notes).toEqual(["evidence_batch_ready:Evidence ready for review"]);
  });

  test("skips silently when the ledger entry is absent", async () => {
    const { deps, acked, notes } = syncSetup();
    await syncEvidence(deps, "missing");
    expect(acked).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("batchReady", () => {
  test("false when any entry is unsettled; true once every entry settles and at least one synced", () => {
    const ledger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-evl-")), "l.json"));
    ledger.upsert({ ...ENTRY, state: "captured" });
    expect(batchReady(ledger, "acme-1-fix")).toBe(false);
    ledger.setState("r1", "synced");
    expect(batchReady(ledger, "acme-1-fix")).toBe(true);
  });

  test("all settled but none synced (all rejected/attached/failed) is not ready", () => {
    const ledger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-evl-")), "l.json"));
    ledger.upsert({ ...ENTRY, state: "rejected" });
    expect(batchReady(ledger, "acme-1-fix")).toBe(false);
  });

  test("empty branch is not ready", () => {
    const ledger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-evl-")), "l.json"));
    expect(batchReady(ledger, "no-such-branch")).toBe(false);
  });
});
