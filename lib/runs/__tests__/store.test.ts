import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { findRun, listRuns, readRun } from "../store.ts";
import { root, seedRun } from "./fixtures.ts";

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

describe("runs store", () => {
  test("listRuns returns newest first, scoped to a repo or across all", () => {
    const dir = root();
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    seedRun(dir, "alpha", "20260821-020202-bbbb", 2000);
    seedRun(dir, "beta",  "20260821-030303-cccc", 3000);
    expect(listRuns("alpha").map(r => r.id)).toEqual(["20260821-020202-bbbb", "20260821-010101-aaaa"]);
    expect(listRuns().map(r => r.repo)).toEqual(["beta", "alpha", "alpha"]);
  });

  test("readRun returns the full document; unknown run is null", () => {
    const dir = root();
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    const d = readRun("alpha", "20260821-010101-aaaa")!;
    expect(d.run.status).toBe("running");
    expect(d.stages).toHaveLength(1);
    expect(d.fields.length).toBeGreaterThan(0);
    expect(d.fields[0]!).toMatchObject({ key: "ticket", value: "ACME-1" });
    expect(d.decisions.length).toBeGreaterThan(0);
    expect(d.decisions[0]!.contract).toBe("execution-strategy@1");
    expect(d.schemaAhead).toBe(false);
    expect(readRun("alpha", "nope")).toBeNull();
  });

  test("findRun resolves the repo by scanning; newer schema flags schemaAhead", () => {
    const dir = root();
    seedRun(dir, "beta", "20260821-030303-cccc", 3000, 99);
    const d = findRun("20260821-030303-cccc")!;
    expect(d.run.repo).toBe("beta");
    expect(d.schemaAhead).toBe(true);
  });

  test("a corrupt or missing state.db is skipped, not thrown", () => {
    const dir = root();
    mkdirSync(join(dir, "alpha", "broken"), { recursive: true });
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    expect(listRuns("alpha")).toHaveLength(1);
  });

  test("corrupt state.db (garbage bytes) is skipped, not thrown", () => {
    const dir = root();
    mkdirSync(join(dir, "alpha", "corrupt"), { recursive: true });
    writeFileSync(join(dir, "alpha", "corrupt", "state.db"), "garbage data");
    seedRun(dir, "alpha", "20260821-010101-aaaa", 1000);
    expect(listRuns("alpha")).toHaveLength(1);
    expect(readRun("alpha", "corrupt")).toBeNull();
    expect(findRun("corrupt")).toBeNull();
  });

  test("path-traversal repo/runId components are rejected, not joined", () => {
    root();
    expect(readRun("..", "x")).toBeNull();
    expect(findRun("a/b")).toBeNull();
  });

  test("reads a v2 DB's failure reason and pack provenance", () => {
    const dir = root();
    seedRun(dir, "acme", "20260822-120000-aaaa", 1000, 2,
      { packCommits: "mattstack=59b90cd", packDirty: 1, stageReason: "assertion failed", stageDetailPath: "/tmp/g.log" });

    const detail = readRun("acme", "20260822-120000-aaaa")!;
    expect(detail.stages[0]!.reason).toBe("assertion failed");
    expect(detail.stages[0]!.detail_path).toBe("/tmp/g.log");
    expect(detail.run.pack_commits).toBe("mattstack=59b90cd");
    expect(detail.run.pack_dirty).toBe(1);
    expect(detail.schemaAhead).toBe(false);
  });

  test("a v1 DB still reads, with the new fields null", () => {
    const dir = root();
    seedRun(dir, "acme", "20260801-090000-bbbb", 1000);   // userVersion defaults to 1

    const detail = readRun("acme", "20260801-090000-bbbb")!;
    expect(detail).not.toBeNull();
    expect(detail.stages[0]!.name).toBe("plan");
    expect(detail.stages[0]!.reason).toBeNull();
    expect(detail.run.pack_commits).toBeNull();
    expect(detail.run.pack_dirty).toBe(0);
  });
});
