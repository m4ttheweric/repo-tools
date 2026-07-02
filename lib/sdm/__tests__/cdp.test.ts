import { describe, test, expect } from "bun:test";
import { createCdpDispatcher } from "../cdp.ts";

describe("createCdpDispatcher", () => {
  test("correlates a response to its request by id", async () => {
    const sent: string[] = [];
    const d = createCdpDispatcher(j => sent.push(j));
    const p = d.request("Page.navigate", { url: "about:blank" }, "sess-1");
    const req = JSON.parse(sent[0]!);
    expect(req.method).toBe("Page.navigate");
    expect(req.sessionId).toBe("sess-1");
    d.handleMessage(JSON.stringify({ id: req.id, result: { frameId: "f1" } }));
    expect(await p).toEqual({ frameId: "f1" });
  });

  test("routes events to on() listeners and ignores unknown ids", async () => {
    const d = createCdpDispatcher(() => {});
    const seen: any[] = [];
    d.on("Page.frameNavigated", p => seen.push(p.frame?.url));
    d.handleMessage(JSON.stringify({ method: "Page.frameNavigated", params: { frame: { url: "https://x/" } } }));
    d.handleMessage(JSON.stringify({ id: 9999, result: {} })); // no pending request; must not throw
    expect(seen).toEqual(["https://x/"]);
  });

  test("distinct requests get distinct ids", () => {
    const sent: string[] = [];
    const d = createCdpDispatcher(j => sent.push(j));
    d.request("A");
    d.request("B");
    const id0 = JSON.parse(sent[0]!).id;
    const id1 = JSON.parse(sent[1]!).id;
    expect(id0).not.toBe(id1);
  });
});
