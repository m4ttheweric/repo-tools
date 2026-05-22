import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-tunnel-mgr-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

function fakeProcessManager() {
  const calls: any[] = [];
  let hasSpawn = false;
  return {
    calls,
    async spawn(id: string, cmd: string, opts: any) {
      calls.push({ kind: "spawn", id, cmd, opts });
      hasSpawn = true;
    },
    async kill(id: string) {
      calls.push({ kind: "kill", id });
      hasSpawn = false;
    },
    getProcess(_id: string) { return hasSpawn ? ({ pid: 12345 } as any) : undefined; },
    getSpawnConfig(_id: string) { return hasSpawn ? { cmd: "x", cwd: "y" } : undefined; },
  };
}

const cfg = {
  tunnelId: "abc-123",
  tunnelName: "m",
  credentialsFile: "/cred/abc-123.json",
  baseDomain: "m4tthew.dev",
  hostnamePrefix: "p",
};

describe("TunnelManager", () => {
  test("apply with no enabled lanes does not spawn cloudflared", async () => {
    const { saveTunnelConfig } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any });
    await mgr.apply("board1", []);
    expect(pm.calls.find((c) => c.kind === "spawn")).toBeUndefined();
  });

  test("apply with one enabled lane writes YAML and spawns cloudflared", async () => {
    const { saveTunnelConfig, runtimeYamlPath } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any });
    await mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } },
    ] as any);

    const yamlPath = runtimeYamlPath("board1");
    expect(existsSync(yamlPath)).toBe(true);
    const yaml = readFileSync(yamlPath, "utf8");
    expect(yaml).toContain("p4000.m4tthew.dev");

    const spawn = pm.calls.find((c) => c.kind === "spawn");
    expect(spawn).toBeDefined();
    expect(spawn.cmd).toContain("cloudflared");
    expect(spawn.cmd).toContain("--config");
    expect(spawn.cmd).toContain(yamlPath);
    expect(spawn.cmd).toContain("run");
  });

  test("apply twice with same set rewrites YAML and SIGHUPs instead of respawning", async () => {
    const { saveTunnelConfig } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const killSignals: NodeJS.Signals[] = [];
    const origKill = process.kill;
    (process as any).kill = (pid: number, sig: NodeJS.Signals) => {
      killSignals.push(sig);
    };
    try {
      const mgr = new TunnelManager({ processManager: pm as any });
      const lanes = [{ id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } }] as any;
      await mgr.apply("board1", lanes);
      await mgr.apply("board1", lanes);
      const spawnCount = pm.calls.filter((c) => c.kind === "spawn").length;
      expect(spawnCount).toBe(1);
      expect(killSignals).toContain("SIGHUP");
    } finally {
      (process as any).kill = origKill;
    }
  });

  test("apply with all lanes disabled after previously enabled stops cloudflared", async () => {
    const { saveTunnelConfig } = await import("../../tunnel-config.ts");
    saveTunnelConfig(cfg);
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any });
    await mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } } as any,
    ]);
    await mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: false } } as any,
    ]);
    expect(pm.calls.find((c) => c.kind === "kill")).toBeDefined();
  });

  test("apply throws when global tunnel config is missing", async () => {
    // Do NOT save config first
    const { TunnelManager } = await import("../tunnel-manager.ts");
    const pm = fakeProcessManager();
    const mgr = new TunnelManager({ processManager: pm as any });
    await expect(mgr.apply("board1", [
      { id: "1", canonicalPort: 4000, entries: [], repoName: "r", mode: "warm",
        tunnel: { enabled: true } } as any,
    ])).rejects.toThrow(/not configured/i);
  });
});
