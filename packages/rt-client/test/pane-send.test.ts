import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { paneSend } from "../src/index.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

describe("paneSend", () => {
  test("sends paneId + text, omits callerPane when absent, and returns the result verbatim", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "queued" } },
    });
    stops.push(stop);
    const res = await paneSend({ paneId: "w1:p2", text: "hi" }, { sockPath: sock });
    expect(res).toEqual({ ok: true, data: { paneId: "w1:p2", delivered: "queued" } });
    expect(seen).toEqual([{ cmd: "pane:send", payload: { paneId: "w1:p2", text: "hi" } }]);
  });

  test("rides callerPane on the payload when given", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "accepted" } },
    });
    stops.push(stop);
    await paneSend({ paneId: "w1:p2", text: "hi", callerPane: "w1:p1" }, { sockPath: sock });
    expect(seen[0]!.payload).toEqual({ paneId: "w1:p2", text: "hi", callerPane: "w1:p1" });
  });

  test("defaults to a 30s timeout, overridable via opts", async () => {
    const { sock, stop } = fakeDaemon({
      "pane:send": { ok: true, data: { paneId: "w1:p2", delivered: "queued" } },
    });
    stops.push(stop);
    const spy = spyOn(AbortSignal, "timeout");
    await paneSend({ paneId: "w1:p2", text: "hi" }, { sockPath: sock });
    await paneSend({ paneId: "w1:p2", text: "hi" }, { sockPath: sock, timeoutMs: 5_000 });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([30_000, 5_000]);
    spy.mockRestore();
  });
});
