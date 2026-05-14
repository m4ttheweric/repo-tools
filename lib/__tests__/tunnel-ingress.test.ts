import { describe, test, expect } from "bun:test";
import { generateIngressYaml } from "../tunnel-ingress.ts";
import type { LaneConfig } from "../runner-store.ts";
import type { TunnelConfig } from "../tunnel-config.ts";

const cfg: TunnelConfig = {
  tunnelId: "abc-123",
  tunnelName: "matt-laptop",
  credentialsFile: "/Users/matt/.cloudflared/abc-123.json",
  baseDomain: "m4tthew.dev",
  hostnamePrefix: "p",
};

function lane(id: string, port: number, enabled?: boolean): LaneConfig {
  return {
    id, canonicalPort: port, entries: [], repoName: "r", mode: "warm",
    ...(enabled === undefined ? {} : { tunnel: { enabled } }),
  };
}

describe("generateIngressYaml", () => {
  test("emits header + catch-all even with zero enabled lanes", () => {
    const yaml = generateIngressYaml(cfg, []);
    expect(yaml).toContain("tunnel: abc-123");
    expect(yaml).toContain("credentials-file: /Users/matt/.cloudflared/abc-123.json");
    expect(yaml).toContain("ingress:");
    expect(yaml).toContain("- service: http_status:404");
  });

  test("includes one rule per enabled lane, in lane.id order", () => {
    const yaml = generateIngressYaml(cfg, [
      lane("2", 4001, true),
      lane("1", 4000, true),
      lane("3", 4002, false), // disabled — must be skipped
    ]);
    const i1 = yaml.indexOf("p4000.m4tthew.dev");
    const i2 = yaml.indexOf("p4001.m4tthew.dev");
    const i3 = yaml.indexOf("p4002.m4tthew.dev");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBe(-1);
  });

  test("each rule maps hostname → http://localhost:<canonicalPort>", () => {
    const yaml = generateIngressYaml(cfg, [lane("1", 4000, true)]);
    expect(yaml).toMatch(/- hostname: p4000\.m4tthew\.dev\s+service: http:\/\/localhost:4000/);
  });

  test("absent tunnel field ≡ disabled (no rule emitted)", () => {
    const yaml = generateIngressYaml(cfg, [lane("1", 4000)]);
    expect(yaml).not.toContain("p4000.m4tthew.dev");
  });

  test("empty prefix yields pure-numeric subdomain", () => {
    const yaml = generateIngressYaml({ ...cfg, hostnamePrefix: "" }, [lane("1", 4000, true)]);
    expect(yaml).toContain("4000.m4tthew.dev");
    expect(yaml).not.toContain("p4000.m4tthew.dev");
  });
});
