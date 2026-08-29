import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { paneFocus } from "../src/index.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

describe("paneFocus", () => {
  test("sends just the paneId and returns the result verbatim", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "pane:focus": { ok: true, data: { paneId: "w1:p2", focused: true } },
    });
    stops.push(stop);
    const res = await paneFocus({ paneId: "w1:p2" }, { sockPath: sock });
    expect(res).toEqual({ ok: true, data: { paneId: "w1:p2", focused: true } });
    expect(seen).toEqual([{ cmd: "pane:focus", payload: { paneId: "w1:p2" } }]);
  });

  test("defaults to a 10s timeout, overridable via opts", async () => {
    const { sock, stop } = fakeDaemon({
      "pane:focus": { ok: true, data: { paneId: "w1:p2", focused: true } },
    });
    stops.push(stop);
    const spy = spyOn(AbortSignal, "timeout");
    await paneFocus({ paneId: "w1:p2" }, { sockPath: sock });
    await paneFocus({ paneId: "w1:p2" }, { sockPath: sock, timeoutMs: 3_000 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([10_000, 3_000]);
    spy.mockRestore();
  });
});
