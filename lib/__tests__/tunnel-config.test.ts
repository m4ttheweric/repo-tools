import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmp: string;
let origHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-tunnel-cfg-"));
  origHome = process.env.HOME;
  process.env.HOME = tmp;
});
afterEach(() => {
  if (origHome) process.env.HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("tunnel-config", () => {
  test("loadTunnelConfig returns null when file missing", async () => {
    const { loadTunnelConfig } = await import("../tunnel-config.ts");
    expect(loadTunnelConfig()).toBeNull();
  });

  test("saveTunnelConfig then loadTunnelConfig round-trips", async () => {
    const { saveTunnelConfig, loadTunnelConfig } = await import("../tunnel-config.ts");
    saveTunnelConfig({
      tunnelId: "abc-123",
      tunnelName: "matt-laptop",
      credentialsFile: "/Users/matt/.cloudflared/abc-123.json",
      baseDomain: "m4tthew.dev",
      hostnamePrefix: "p",
    });
    expect(loadTunnelConfig()).toEqual({
      tunnelId: "abc-123",
      tunnelName: "matt-laptop",
      credentialsFile: "/Users/matt/.cloudflared/abc-123.json",
      baseDomain: "m4tthew.dev",
      hostnamePrefix: "p",
    });
  });

  test("hostnameFor composes prefix + port + baseDomain", async () => {
    const { hostnameFor } = await import("../tunnel-config.ts");
    expect(hostnameFor({ baseDomain: "m4tthew.dev", hostnamePrefix: "p" } as any, 4000))
      .toBe("p4000.m4tthew.dev");
    expect(hostnameFor({ baseDomain: "m4tthew.dev", hostnamePrefix: "" } as any, 4000))
      .toBe("4000.m4tthew.dev");
  });

  test("loadTunnelConfig throws on malformed JSON instead of silently returning null", async () => {
    const dir = join(tmp, ".rt", "tunnels");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ not json");
    const { loadTunnelConfig } = await import("../tunnel-config.ts");
    expect(() => loadTunnelConfig()).toThrow();
  });
});
