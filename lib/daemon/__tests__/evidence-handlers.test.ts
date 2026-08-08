import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceHandlers, type EvidenceHandlerOverrides } from "../handlers/evidence.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { createEvidenceLedger } from "../evidence-ledger.ts";
import type { EvidenceLedgerEntry } from "../evidence-ledger.ts";
import type { SandboxClient } from "../../sandbox.ts";
import type { EvidenceConfig } from "../../evidence-config.ts";

const ctx = { log: { info: () => {}, warn: () => {}, debug: () => {} } } as unknown as HandlerContext;

// Task 9's evidence-config fixture (lib/__tests__/evidence-config.test.ts), extended
// with an identity-gated view and an in-test evidenceRoot temp dir.
const CONFIG_FIXTURE: EvidenceConfig = {
  evidenceRoot: mkdtempSync(join(tmpdir(), "rt-evroot-")),
  appPort: 4001,
  views: {
    "cvi-case": { path: "/cv/{caseId}/s/{contactId?}", ready: { selector: "[data-x]" } },
    "god-view": { path: "/cases/{caseId}", identityGated: true },
  },
  recipes: { shot: { args: { section: "overview" }, annotate: [] } },
  login: { url: "/", fields: { "#u": "QA_USER" }, submit: "button", assertAuthed: { selector: "[data-user]" } },
};

const ENTRY: EvidenceLedgerEntry = {
  requestId: "r1",
  executor: "sidecar",
  sandboxId: "sb1",
  repoId: "demo",
  branch: "cv-1-fix",
  caseId: "c1",
  view: "cvi-case",
  recipe: "shot",
  slot: "after",
  state: "requested",
  requestedAt: "2026-08-08T00:00:00.000Z",
};

function makeHandlers(over: Partial<EvidenceHandlerOverrides> = {}) {
  const ledger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-evh-")), "l.json"));
  const frames: Array<{ type: string; data: any }> = [];
  const client = { requestEvidence: async () => ({ requestId: "r1" }) } as unknown as SandboxClient;
  const config = () => CONFIG_FIXTURE;
  const h = createEvidenceHandlers(ctx, (type, data) => frames.push({ type, data }),
    { ledger, client, config, sync: async () => {}, ...over });
  return { h, ledger, frames };
}

describe("evidence handlers", () => {
  test("request: sidecar path calls the controller and upserts requested", async () => {
    const { h, ledger, frames } = makeHandlers();
    const r = await h["evidence:request"]!({
      repoId: "demo", branch: "cv-1-fix", sandboxId: "sb1",
      caseId: "c1", view: "cvi-case", recipe: "shot", slot: "after",
    });
    expect(r.ok).toBe(true);
    expect(r.data.executor).toBe("sidecar");
    expect(ledger.read("r1")!.state).toBe("requested");
    expect(frames.at(-1)!.type).toBe("evidence:updated");
  });

  test("request: explicit executor local-chrome on a non-identityGated view still goes local", async () => {
    // Proves the pass-through path `--local` now relies on (commands/evidence.ts
    // requestCommand): an explicit executor overrides the identityGated default,
    // so a non-gated view never falls through to the sidecar's sandboxId check.
    const { h, ledger } = makeHandlers();
    const r = await h["evidence:request"]!({
      repoId: "demo", branch: "cv-1-fix",
      caseId: "c1", view: "cvi-case", recipe: "shot", slot: "standalone",
      executor: "local-chrome",
    });
    expect(r.ok).toBe(true);
    expect(r.data.executor).toBe("local-chrome");
    expect(r.data.requestId.startsWith("local-")).toBe(true);
    expect(ledger.read(r.data.requestId)!.sandboxId).toBeNull();
  });

  test("request: identityGated view defaults to local-chrome with a local- requestId", async () => {
    const { h, ledger } = makeHandlers();
    const r = await h["evidence:request"]!({
      repoId: "demo", branch: "cv-1-fix",
      caseId: "c1", view: "god-view", recipe: "shot", slot: "standalone",
    });
    expect(r.data.executor).toBe("local-chrome");
    expect(r.data.requestId.startsWith("local-")).toBe(true);
    expect(ledger.read(r.data.requestId)!.sandboxId).toBeNull();
  });

  test("request: validateRequestArgs failures reject", async () => {
    const { h } = makeHandlers();
    const r = await h["evidence:request"]!({
      repoId: "demo", branch: "b", sandboxId: "sb1",
      caseId: "c1", view: "nope", recipe: "shot", slot: "after",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown view");
  });

  test("approve only from synced; reject requires a reason", async () => {
    const { h, ledger } = makeHandlers();
    ledger.upsert({ ...ENTRY, state: "requested" });
    expect((await h["evidence:approve"]!({ requestId: "r1" })).ok).toBe(false);
    ledger.setState("r1", "synced");
    expect((await h["evidence:reject"]!({ requestId: "r1" })).ok).toBe(false);       // no reason
    expect((await h["evidence:approve"]!({ requestId: "r1" })).ok).toBe(true);
    expect(ledger.read("r1")!.state).toBe("approved");
  });

  test("fulfill copies local files into the tree slot and flips to synced", async () => {
    const { h, ledger } = makeHandlers();
    ledger.upsert({ ...ENTRY, requestId: "local-1", executor: "local-chrome", sandboxId: null });
    const src = join(mkdtempSync(join(tmpdir(), "rt-src-")), "shot.png");
    writeFileSync(src, "png");
    const r = await h["evidence:fulfill"]!({ requestId: "local-1", basePath: src });
    expect(r.ok).toBe(true);
    const e = ledger.read("local-1")!;
    expect(e.state).toBe("synced");
    expect(existsSync(e.files!.base)).toBe(true);
    expect(existsSync(e.files!.manifest)).toBe(true);
  });

  test("reject requires state synced too", async () => {
    const { h, ledger } = makeHandlers();
    ledger.upsert({ ...ENTRY, state: "requested" });
    const r = await h["evidence:reject"]!({ requestId: "r1", reason: "blurry" });
    expect(r.ok).toBe(false);
  });

  test("reject from synced with a reason succeeds and records it", async () => {
    const { h, ledger, frames } = makeHandlers();
    ledger.upsert({ ...ENTRY, state: "synced" });
    const r = await h["evidence:reject"]!({ requestId: "r1", reason: "blurry" });
    expect(r.ok).toBe(true);
    expect(ledger.read("r1")!.state).toBe("rejected");
    expect(ledger.read("r1")!.reason).toBe("blurry");
    expect(frames.at(-1)).toEqual({ type: "evidence:updated", data: { requestId: "r1", state: "rejected" } });
  });

  test("mark-attached only legal from approved", async () => {
    const { h, ledger } = makeHandlers();
    ledger.upsert({ ...ENTRY, state: "synced" });
    expect((await h["evidence:mark-attached"]!({ requestId: "r1" })).ok).toBe(false);
    ledger.setState("r1", "approved");
    const r = await h["evidence:mark-attached"]!({ requestId: "r1" });
    expect(r.ok).toBe(true);
    expect(ledger.read("r1")!.state).toBe("attached");
  });

  test("redraw is legal from synced or approved and records a redraw without changing state", async () => {
    const { h, ledger } = makeHandlers();
    ledger.upsert({ ...ENTRY, state: "requested" });
    expect((await h["evidence:redraw"]!({ requestId: "r1", annotatedPath: "x" })).ok).toBe(false);

    ledger.setState("r1", "synced");
    const annotated = join(mkdtempSync(join(tmpdir(), "rt-redraw-")), "redraw.png");
    writeFileSync(annotated, "png2");
    const r = await h["evidence:redraw"]!({ requestId: "r1", annotatedPath: annotated });
    expect(r.ok).toBe(true);
    const e = ledger.read("r1")!;
    expect(e.state).toBe("synced");
    expect(existsSync(e.files!.annotated!)).toBe(true);
    expect(e.redraws!.length).toBe(1);
  });

  test("list passes the filter through to the ledger", async () => {
    const { h, ledger } = makeHandlers();
    ledger.upsert({ ...ENTRY, state: "synced" });
    ledger.upsert({ ...ENTRY, requestId: "r2", branch: "other", state: "requested" });
    const r = await h["evidence:list"]!({ branch: "cv-1-fix" });
    expect(r.ok).toBe(true);
    expect(r.data.map((e: EvidenceLedgerEntry) => e.requestId)).toEqual(["r1"]);
  });

  test("pull with no requestId syncs every captured entry and reports the synced ids", async () => {
    const ledger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-evh-")), "l.json"));
    ledger.upsert({ ...ENTRY, state: "captured" });
    ledger.upsert({ ...ENTRY, requestId: "r2", state: "captured" });
    const synced: string[] = [];
    const client = { requestEvidence: async () => ({ requestId: "r1" }) } as unknown as SandboxClient;
    const h = createEvidenceHandlers(ctx, () => {}, {
      ledger, client, config: () => CONFIG_FIXTURE,
      sync: async (id) => { ledger.setState(id, "synced"); synced.push(id); },
    });
    const r = await h["evidence:pull"]!({});
    expect(r.ok).toBe(true);
    expect(r.data.synced.sort()).toEqual(["r1", "r2"]);
  });

  test("pull with an explicit unknown requestId rejects instead of silently syncing nothing", async () => {
    const { h } = makeHandlers();
    const r = await h["evidence:pull"]!({ requestId: "no-such-id" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("unknown requestId: no-such-id");
  });
});
