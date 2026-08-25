/**
 * Public-surface guard for the settings registry API (RT-50): every consumer
 * in-process (deck/board/gitq) reaches these through the npm package entry
 * point, not `src/settings/registry-machinery.ts` directly — an export
 * missing from index.ts strands them even though the source module has it.
 * registry-machinery.ts's own docblock mandates calling `isMigrated()`
 * instead of testing `def.migrated`; this test caught that mandate not
 * reaching the public surface once already (RT-50 task 9 review).
 */

import { describe, expect, test } from "bun:test";
import * as rtClient from "../src/index.ts";

describe("index.ts settings registry surface", () => {
  test("exports the full registry API", () => {
    expect(typeof rtClient.getDef).toBe("function");
    expect(typeof rtClient.allDefs).toBe("function");
    expect(typeof rtClient.validateValue).toBe("function");
    expect(typeof rtClient.isMigrated).toBe("function");
    expect(Array.isArray(rtClient.REGISTRY)).toBe(true);
  });

  test("isMigrated is usable end to end against a real registry def", () => {
    const def = rtClient.getDef("deck.access");

    expect(def).toBeDefined();
    expect(rtClient.isMigrated(def!)).toBe(true);
  });
});

describe("index.ts runs surface", () => {
  test("exports the run read and reconcile API", () => {
    expect(typeof rtClient.listRuns).toBe("function");
    expect(typeof rtClient.getRun).toBe("function");
    expect(typeof rtClient.abandonRun).toBe("function");
  });
});

describe("index.ts branch cache surface", () => {
  test("exports readBranchCache", () => {
    expect(typeof rtClient.readBranchCache).toBe("function");
  });
});
