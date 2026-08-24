import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue, listKvValues } from "../index.ts";
import { rekeyKvNamespace } from "../identity-migrate.ts";

describe("rekeyKvNamespace", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "rt-rek-")); process.env.HOME = home; closeStateDb(); warnSpy = spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); process.env.HOME = origHome; closeStateDb(); rmSync(home, { recursive: true, force: true }); });

  test("a legacy name resolvable to a remote identity is re-keyed", async () => {
    setKvValue("repo-index", "repo-tools", "/tmp/does-not-need-to-exist");
    setKvValue("demo-ns", "repo-tools", { v: 1 });
    // resolveLegacyKey is fed a fixed resolver in the test via opts:
    const report = await rekeyKvNamespace("demo-ns", {
      resolve: async (name) => (name === "repo-tools" ? "remote:gitlab.com%2Fg%2Frepo-tools" : null),
    });
    expect(report.migrated).toEqual(["repo-tools"]);
    const rows = listKvValues("demo-ns");
    expect(rows["remote:gitlab.com%2Fg%2Frepo-tools"]).toEqual({ v: 1 });
    expect(rows["repo-tools"]).toBeUndefined();
  });

  test("a key already a serialized identity is left untouched", async () => {
    setKvValue("demo-ns", "remote:gitlab.com%2Fg%2Fr", { v: 2 });
    const report = await rekeyKvNamespace("demo-ns", { resolve: async () => null });
    expect(report.migrated).toEqual([]);
    expect(listKvValues("demo-ns")["remote:gitlab.com%2Fg%2Fr"]).toEqual({ v: 2 });
  });

  test("an unresolvable legacy name is retained and warned, never dropped", async () => {
    setKvValue("demo-ns", "ghost", { v: 3 });
    const report = await rekeyKvNamespace("demo-ns", { resolve: async () => null });
    expect(report.retained).toEqual(["ghost"]);
    expect(listKvValues("demo-ns")["ghost"]).toEqual({ v: 3 });
    expect(warnSpy).toHaveBeenCalled();
  });
});
