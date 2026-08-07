import { describe, expect, test } from "bun:test";
import { parseCronConfig, startCron, type CronTrigger } from "../cron.ts";

const log = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parseCronConfig", () => {
  test("parses jsonc and validates triggers", () => {
    const cfg = parseCronConfig(`{
      // the auto-doctor trigger
      "triggers": [{ "name": "t", "event": "project-mrs", "repoName": "acme-dev", "run": ["echo", "hi"] }]
    }`);
    expect(cfg.triggers).toHaveLength(1);
    expect(cfg.triggers[0]!.debounceMs).toBeUndefined();
  });

  test("rejects triggers missing name/event/run", () => {
    expect(() => parseCronConfig(`{"triggers":[{"event":"x","run":["a"]}]}`)).toThrow();
    expect(() => parseCronConfig(`{"triggers":[{"name":"t","event":"x","run":[]}]}`)).toThrow();
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
