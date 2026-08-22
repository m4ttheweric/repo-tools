import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { enrichmentCmd, enrichmentSkeleton } from "../../../commands/sdm.ts";
import { enrichmentPath, stripJsonc } from "../enrichment.ts";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { teamSettingsPath } from "../../rt-paths.ts";

function writeStore(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

describe("enrichmentSkeleton", () => {
  test("contains every resource name as a JSON key", () => {
    const names = ["assured-alpha-staging", "assured-beta-qa-prod"];
    const skeleton = enrichmentSkeleton(names);
    for (const name of names) {
      expect(skeleton).toContain(JSON.stringify(name));
    }
  });

  test("parses as valid JSON after stripping JSONC comments", () => {
    const names = ["assured-alpha-staging", "assured-beta-qa-prod"];
    const parsed = JSON.parse(stripJsonc(enrichmentSkeleton(names)));
    expect(Object.keys(parsed)).toEqual(names);
    for (const name of names) {
      expect(parsed[name]).toEqual({ label: "", tier: "" });
    }
  });

  test("empty resource list still produces a valid, parseable object", () => {
    const parsed = JSON.parse(stripJsonc(enrichmentSkeleton([])));
    expect(parsed).toEqual({});
  });
});

describe("enrichmentCmd init: scaffold refusal when the team store owns rt.sdmEnrichment", () => {
  let originalLog: typeof console.log;
  let logs: string[];

  beforeEach(() => {
    // Store-owned returns before ever reaching the network scan, so this
    // needs no daemon/StrongDM stubbing — just an isolated HOME.
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "enr-cmd-home-")));
    logs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("prints a note naming the file it would otherwise write, and never scaffolds it", async () => {
    writeStore(teamSettingsPath("acme"), { "rt.sdmEnrichment": { "res-a": { label: "A" } } });
    const path = enrichmentPath();

    await enrichmentCmd(["init"]);

    expect(existsSync(path)).toBe(false);
    const output = logs.join("\n");
    expect(output).toContain(path);
    expect(output).toContain("team store");
  });
});
