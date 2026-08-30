import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { listRuns } from "../store.ts";
import { root, seedRun } from "./fixtures.ts";

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

test("a finished run's db is opened once, then served from the mtime cache", () => {
  const dir = root();
  seedRun(dir, "repoA", "run1", 1000, 1, { status: "done" });
  const openSpy = spyOn(Database.prototype, "query");
  listRuns();                 // first call opens + reads
  const afterFirst = openSpy.mock.calls.length;
  listRuns();                 // second call: mtime unchanged -> no reopen
  expect(openSpy.mock.calls.length).toBe(afterFirst); // no additional queries for run1
  openSpy.mockRestore();
});

test("a running run is never cached: it is reopened even when its mtime is unchanged", () => {
  const dir = root();
  seedRun(dir, "repoA", "run2", 1000, 1, { status: "running" });
  const openSpy = spyOn(Database.prototype, "query");
  listRuns();
  const afterFirst = openSpy.mock.calls.length;
  listRuns();
  expect(openSpy.mock.calls.length).toBeGreaterThan(afterFirst);
  openSpy.mockRestore();
});
