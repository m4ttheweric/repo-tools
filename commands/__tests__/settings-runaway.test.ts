import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSetting } from "../../lib/settings/resolve.ts";
import { setSetting } from "../../lib/settings/write.ts";
import { configureRunaway } from "../settings.ts";

describe("configureRunaway through the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;
  let logs: string[];
  const origLog = console.log;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-runaway-cmd-")));
    process.env.HOME = home;
    logs = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  });

  afterEach(() => {
    process.env.HOME = origHome;
    console.log = origLog;
    rmSync(home, { recursive: true, force: true });
  });

  test("empty store: the summary view prints today's defaults", async () => {
    await configureRunaway([]);
    expect(logs.some((l) => l.includes("80%"))).toBe(true);
  });

  test("setting a field lands in the machine store", async () => {
    await configureRunaway(["cpu-threshold", "90"]);

    const stored = getSetting<Record<string, number>>("rt.runaway").value;
    expect(stored.cpuThreshold).toBe(90);
    expect(logs.some((l) => l.includes("restart daemon"))).toBe(true);
  });

  test("an existing stored value is preserved across an unrelated field write", async () => {
    setSetting("rt.runaway", { cpuThreshold: 70 }, "machine");

    await configureRunaway(["sustain-min", "10"]);

    const stored = getSetting<Record<string, number>>("rt.runaway").value;
    expect(stored.cpuThreshold).toBe(70);
    expect(stored.sustainMs).toBe(600_000);
  });
});
