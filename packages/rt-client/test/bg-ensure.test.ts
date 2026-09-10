import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bgEnsure } from "../src/index.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

describe("bgEnsure", () => {
  test("defaults to a 30s budget, overridable via opts", async () => {
    const { sock, stop } = fakeDaemon({
      "bg:ensure": { ok: true, data: { socket: "/tmp/bg.sock", started: true, parity: null } },
    });
    stops.push(stop);
    const spy = spyOn(AbortSignal, "timeout");
    await bgEnsure({}, { sockPath: sock });
    await bgEnsure({}, { sockPath: sock, timeoutMs: 3_000 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([30_000, 3_000]);
    spy.mockRestore();
  });
});
