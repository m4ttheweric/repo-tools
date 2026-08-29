import { test, expect } from "bun:test";
import { applyInvalidationBatch, PENDING_CAP } from "../freshness.ts";

test("merged pending is deduped by kind:ref and capped", async () => {
  const runner: any = { processing: true, pending: [] };
  // Push more distinct keys than the cap; plus duplicates.
  const keys = Array.from({ length: PENDING_CAP + 500 }, (_, i) => ({ kind: "mr" as const, ref: String(i), cause: "test" }));
  const dupes = [{ kind: "mr" as const, ref: "0", cause: "test" }, { kind: "mr" as const, ref: "0", cause: "test" }];
  await applyInvalidationBatch({} as any, {} as any, runner, [...keys, ...dupes], {});
  expect(runner.pending.length).toBeLessThanOrEqual(PENDING_CAP);
  const ids = runner.pending.map((k: any) => `${k.kind}:${k.ref}`);
  expect(new Set(ids).size).toBe(ids.length); // no duplicates
});
