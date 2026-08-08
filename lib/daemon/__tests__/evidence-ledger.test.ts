import { describe, test, expect } from "bun:test";
import { createEvidenceLedger } from "../evidence-ledger";
import type { EvidenceLedgerEntry } from "../evidence-ledger";
import { join } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rt-evl-")), "evidence-ledger.json");
}

const ENTRY: EvidenceLedgerEntry = {
  requestId: "r1",
  executor: "sidecar",
  sandboxId: "sb1",
  repoId: "demo",
  branch: "cv-1-fix",
  caseId: "c1",
  view: "v",
  recipe: "rec",
  slot: "after",
  state: "requested",
  requestedAt: "2026-08-08T00:00:00.000Z",
};

describe("evidence-ledger", () => {
  test("upsert persists across a re-open on the same path", () => {
    const path = ledgerPath();
    createEvidenceLedger(path).upsert(ENTRY);
    expect(createEvidenceLedger(path).read("r1")!.branch).toBe("cv-1-fix");
  });

  test("list filters by branch, states, sandboxId; sorted by requestedAt", () => {
    const led = createEvidenceLedger(ledgerPath());
    led.upsert(ENTRY);
    led.upsert({
      ...ENTRY,
      requestId: "r0",
      requestedAt: "2026-08-07T00:00:00.000Z",
      state: "synced",
    });
    led.upsert({ ...ENTRY, requestId: "rX", branch: "other" });
    expect(led.list({ branch: "cv-1-fix" }).map((e) => e.requestId)).toEqual([
      "r0",
      "r1",
    ]);
    expect(led.list({ states: ["synced"] }).map((e) => e.requestId)).toEqual([
      "r0",
    ]);
    expect(led.list({ sandboxId: "sb1" }).length).toBe(3);
  });

  test("setState stamps the matching timestamp and merges the patch; recordRedraw appends", () => {
    const led = createEvidenceLedger(ledgerPath());
    led.upsert(ENTRY);
    led.setState("r1", "rejected", { reason: "wrong section" });
    const e = led.read("r1")!;
    expect(e.state).toBe("rejected");
    expect(e.reason).toBe("wrong section");
    expect(typeof e.decidedAt).toBe("string");
    led.recordRedraw("r1", "2026-08-08T01:00:00.000Z");
    led.recordRedraw("r1", "2026-08-08T02:00:00.000Z");
    expect(led.read("r1")!.redraws!.length).toBe(2);
  });

  test("corrupt file cold-starts empty", () => {
    const path = ledgerPath();
    writeFileSync(path, "{{{");
    expect(createEvidenceLedger(path).list()).toEqual([]);
  });
});
