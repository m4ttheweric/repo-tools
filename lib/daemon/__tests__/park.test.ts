import { describe, test, expect } from "bun:test";
import { parkUntilIntended, type ParkDeps } from "../park.ts";

function deps(overrides: Partial<ParkDeps> = {}): ParkDeps & { logs: string[]; sleeps: number[] } {
  const logs: string[] = [];
  const sleeps: number[] = [];
  return {
    myFlavor: "dev",
    resolveIntent: () => ({ mode: "dev", provenance: "setting" as const }),
    probeHolder: async () => null,
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: { info: (_o: unknown, m: string) => logs.push(`info:${m}`), warn: (_o: unknown, m: string) => logs.push(`warn:${m}`) },
    logs,
    sleeps,
    ...overrides,
  };
}

describe("parkUntilIntended", () => {
  test("matched flavor with free socket returns immediately, no sleep", async () => {
    const d = deps();
    await parkUntilIntended(d);
    expect(d.sleeps).toEqual([]);
  });

  test("mismatched flavor parks until the setting flips, then returns", async () => {
    let reads = 0;
    const d = deps({
      resolveIntent: () => (++reads < 3 ? { mode: "prod", provenance: "setting" } : { mode: "dev", provenance: "setting" }),
    });
    await parkUntilIntended(d);
    expect(d.sleeps.length).toBe(2);
    expect(d.logs.some((l) => l.includes("parked"))).toBe(true);
  });

  test("matched but a live wrong-flavor holder owns the socket: stands off until it drains", async () => {
    let probes = 0;
    const d = deps({
      probeHolder: async () => (++probes < 2 ? { flavor: "prod", pid: 999 } : null),
    });
    await parkUntilIntended(d);
    expect(d.sleeps.length).toBe(1);
    expect(d.logs.some((l) => l.includes("standoff"))).toBe(true);
  });

  test("a resolver that throws keeps the previous decision and logs warn, never crashes", async () => {
    let reads = 0;
    const d = deps({
      resolveIntent: () => {
        reads++;
        if (reads === 2) throw new Error("store hiccup");
        return reads < 4 ? { mode: "prod", provenance: "setting" } : { mode: "dev", provenance: "setting" };
      },
    });
    await parkUntilIntended(d);
    expect(d.logs.some((l) => l.startsWith("warn:"))).toBe(true);
  });

  test("a matched holder answering on the socket also blocks (never two binders)", async () => {
    let probes = 0;
    const d = deps({ probeHolder: async () => (++probes < 2 ? { flavor: "dev", pid: 111 } : null) });
    await parkUntilIntended(d);
    expect(d.sleeps.length).toBe(1);
  });
});
