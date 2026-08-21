import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setSetting } from "../../settings/write.ts";
import { parseCronConfig, loadCronConfig, startCron, type CronTrigger } from "../cron.ts";

const log = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parseCronConfig", () => {
  test("parses a resolved object and validates triggers", () => {
    const cfg = parseCronConfig({
      triggers: [{ name: "t", event: "project-mrs", repoName: "acme-dev", run: ["echo", "hi"] }],
    });
    expect(cfg.triggers).toHaveLength(1);
    expect(cfg.triggers[0]!.debounceMs).toBeUndefined();
  });

  test("rejects triggers missing name/event/run", () => {
    expect(() => parseCronConfig({ triggers: [{ event: "x", run: ["a"] }] })).toThrow();
    expect(() => parseCronConfig({ triggers: [{ name: "t", event: "x", run: [] }] })).toThrow();
  });

  test("undefined/empty input degrades to no triggers", () => {
    expect(parseCronConfig(undefined)).toEqual({ triggers: [] });
    expect(parseCronConfig({})).toEqual({ triggers: [] });
  });
});

describe("loadCronConfig through the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-cron-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("empty store degrades to no triggers", () => {
    expect(loadCronConfig()).toEqual({ triggers: [] });
  });

  test("a store-seeded value resolves through the loader", () => {
    setSetting(
      "rt.cron",
      { triggers: [{ name: "t", event: "project-mrs", run: ["echo", "hi"] }] },
      "machine",
    );

    const cfg = loadCronConfig();
    expect(cfg.triggers).toHaveLength(1);
    expect(cfg.triggers[0]!.name).toBe("t");
  });

  test("an invalid stored value degrades to no triggers and warns", () => {
    setSetting("rt.cron", { triggers: [{ name: "t" }] }, "machine");

    const warnings: string[] = [];
    const cfg = loadCronConfig({ info: () => {}, warn: (m) => warnings.push(m) });
    expect(cfg.triggers).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("an unexpandable ${repoRoot} in a trigger's run string degrades to no triggers instead of throwing", () => {
    setSetting(
      "rt.cron",
      { triggers: [{ name: "t", event: "e", run: ["${repoRoot}/script.sh"] }] },
      "machine",
    );

    const warnings: string[] = [];
    expect(() => loadCronConfig({ info: () => {}, warn: (m) => warnings.push(m) })).not.toThrow();
    expect(loadCronConfig()).toEqual({ triggers: [] });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("startCron", () => {
  test("matching events run the command once per debounce window", async () => {
    const runs: string[][] = [];
    const cron = startCron(
      { triggers: [{ name: "t", event: "project-mrs", repoName: "acme-dev", run: ["echo", "hi"], debounceMs: 20 }] },
      { log, runCommand: (argv) => runs.push(argv) },
    );
    cron.onBroadcast("project-mrs", { repoName: "acme-dev" });
    cron.onBroadcast("project-mrs", { repoName: "acme-dev" }); // burst: coalesced
    cron.onBroadcast("project-mrs", { repoName: "other-repo" });  // wrong repo: ignored
    cron.onBroadcast("discussions:update", { repoName: "acme-dev" }); // wrong event: ignored
    expect(runs).toHaveLength(0); // trailing edge: nothing yet
    await sleep(40);
    expect(runs).toEqual([["echo", "hi"]]);
    cron.dispose();
  });

  test("a trigger without repoName matches any payload", async () => {
    const runs: string[][] = [];
    const cron = startCron(
      { triggers: [{ name: "t", event: "tick", run: ["x"], debounceMs: 5 }] },
      { log, runCommand: (argv) => runs.push(argv) },
    );
    cron.onBroadcast("tick", null);
    await sleep(20);
    expect(runs).toHaveLength(1);
    cron.dispose();
  });

  test("dispose cancels pending runs", async () => {
    const runs: string[][] = [];
    const cron = startCron(
      { triggers: [{ name: "t", event: "tick", run: ["x"], debounceMs: 20 }] },
      { log, runCommand: (argv) => runs.push(argv) },
    );
    cron.onBroadcast("tick", null);
    cron.dispose();
    await sleep(40);
    expect(runs).toHaveLength(0);
  });
});
