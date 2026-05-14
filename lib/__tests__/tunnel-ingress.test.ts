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

  test("includes one rule per enabled lane, in lane.id numeric order (not lex)", () => {
    // Use IDs where numeric and lexicographic order disagree:
    //   numeric:  2, 9, 10  → ports 4002, 4009, 4010
    //   lex:      10, 2, 9  → ports 4010, 4002, 4009
    const yaml = generateIngressYaml(cfg, [
      lane("10", 4010, true),
      lane("9",  4009, true),
      lane("2",  4002, true),
      lane("3",  4003, false), // disabled — must be skipped
    ]);
    const i2  = yaml.indexOf("p4002.m4tthew.dev");
    const i9  = yaml.indexOf("p4009.m4tthew.dev");
    const i10 = yaml.indexOf("p4010.m4tthew.dev");
    const iDisabled = yaml.indexOf("p4003.m4tthew.dev");
    expect(i2).toBeGreaterThan(-1);
    expect(i9).toBeGreaterThan(i2);   // 9 after 2 (numeric, not lex which would put 10 first)
    expect(i10).toBeGreaterThan(i9);  // 10 after 9 (numeric)
    expect(iDisabled).toBe(-1);
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
