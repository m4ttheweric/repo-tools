import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setSetting } from "../../settings/write.ts";
import { resolveUserPath, probeTools } from "../user-path.ts";

describe("probeTools", () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "rtpath-"));
    const node = join(binDir, "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n");
    chmodSync(node, 0o755);
  });

  test("reports a tool present on the path", () => {
    expect(probeTools(binDir, ["node"])).toEqual({ hasNode: true });
  });

  test("reports a tool absent from the path", () => {
    expect(probeTools(binDir, ["pnpm"])).toEqual({ hasPnpm: false });
  });

  test("probes every requested name across every path entry", () => {
    const probed = probeTools(`/nonexistent-rt-test:${binDir}`, ["node", "pnpm"]);

    expect(probed).toEqual({ hasNode: true, hasPnpm: false });
  });

  test("an empty path finds nothing", () => {
    expect(probeTools("", ["node"])).toEqual({ hasNode: false });
  });
});

function makeLog() {
  const warns: any[] = [];
  const infos: any[] = [];
  return { log: { warn: (...a: any[]) => warns.push(a), info: (...a: any[]) => infos.push(a) } as any, warns, infos };
}

describe("resolveUserPath", () => {
  test("fish-style space-separated base output is rejected, baseline kept + warn", async () => {
    const { log, warns } = makeLog();
    process.env.PATH = "/usr/bin:/bin";
    const probe = async () => "/opt/homebrew/bin /usr/bin /bin"; // spaces = fish-unsplit
    const out = await resolveUserPath(log, probe);
    expect(out).toBe("/usr/bin:/bin");
    expect(warns.some((w) => JSON.stringify(w).includes("whitespace"))).toBe(true);
  });

  test("a hanging probe returns baseline within the timeout", async () => {
    const { log } = makeLog();
    process.env.PATH = "/usr/bin:/bin";
    const probe = async () => null; // seam models kill/timeout as null
    const out = await resolveUserPath(log, probe);
    expect(out).toBe("/usr/bin:/bin");
  });

  test("base equal to launchd baseline is treated as silent fallback (S062)", async () => {
    const { log, warns } = makeLog();
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    const probe = async (argv: any) => (argv[1] === "-lc" ? "/usr/bin:/bin:/usr/sbin:/sbin" : null);
    const out = await resolveUserPath(log, probe);
    expect(out).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(warns.some((w) => JSON.stringify(w).includes("equals-baseline"))).toBe(true);
  });

  test("rt.daemonPath override skips both probes", async () => {
    const { log } = makeLog();
    let called = false;
    const probe = async () => {
      called = true;
      return "x";
    };
    const scratchHome = mkdtempSync(join(tmpdir(), "rt-daemonpath-override-"));
    const originalHome = process.env.HOME;
    process.env.HOME = scratchHome;
    try {
      setSetting("rt.daemonPath", "/over/bin:/x/bin", "machine");
      const out = await resolveUserPath(log, probe);
      expect(out).toBe("/over/bin:/x/bin");
      expect(called).toBe(false);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  test("valid base accepted; interactive overlay appends a .zshrc-only dir after base", async () => {
    const { log } = makeLog();
    process.env.PATH = "/usr/bin:/bin";
    const probe = async (argv: any) =>
      argv[1] === "-lc" ? "/opt/homebrew/bin:/usr/bin:/bin" : "/opt/homebrew/bin:/usr/bin:/bin:/Users/x/.nvm/versions/node/v22/bin";
    const out = await resolveUserPath(log, probe);
    expect(out).toBe("/opt/homebrew/bin:/usr/bin:/bin:/Users/x/.nvm/versions/node/v22/bin");
  });

  test("overlay timeout is skipped with a warn; base kept unchanged", async () => {
    const { log, warns } = makeLog();
    process.env.PATH = "/usr/bin:/bin";
    const probe = async (argv: any) => (argv[1] === "-lc" ? "/opt/homebrew/bin:/usr/bin:/bin" : null);
    const out = await resolveUserPath(log, probe);
    expect(out).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(warns.some((w) => JSON.stringify(w).includes("overlay"))).toBe(true);
  });

  test("garbage overlay (non-null, no absolute dirs) is skipped with a warn", async () => {
    const { log, warns } = makeLog();
    process.env.PATH = "/usr/bin:/bin";
    const probe = async (argv: any) => (argv[1] === "-lc" ? "/opt/homebrew/bin:/usr/bin:/bin" : "not-a-path:also-not");
    const out = await resolveUserPath(log, probe);
    expect(out).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(warns.some((w) => JSON.stringify(w).includes("overlay"))).toBe(true);
  });

  test("missing-tool warn fires when node is absent", async () => {
    const { log, warns } = makeLog();
    process.env.PATH = "/usr/bin:/bin";
    const probe = async () => "/usr/bin:/bin"; // no node
    await resolveUserPath(log, probe);
    expect(warns.some((w) => JSON.stringify(w).includes("missing"))).toBe(true);
  });
});
