import { describe, test, expect } from "bun:test";
import { broadcastToClients, type BroadcastTarget } from "../api-server.ts";

function fakeClient(sendReturns: number[]): BroadcastTarget & { closed: boolean; sent: string[] } {
  const sent: string[] = [];
  let i = 0;
  const client = {
    closed: false,
    sent,
    send(data: string) {
      sent.push(data);
      const ret = sendReturns[Math.min(i, sendReturns.length - 1)] as number;
      i++;
      return ret;
    },
    close() { client.closed = true; },
  };
  return client;
}

function fakeLog() {
  const warns: unknown[] = [];
  return { warn: (o: unknown, _m: string) => { warns.push(o); }, warns };
}

describe("broadcastToClients", () => {
  test("a healthy client (positive send return) is never closed", () => {
    const client = fakeClient([42]);
    broadcastToClients([client], "status", { ok: true }, fakeLog());
    expect(client.closed).toBe(false);
    expect(client.sent.length).toBe(1);
  });

  test("a send() returning 0 (dropped frame) closes the client immediately and logs a warning", () => {
    const client = fakeClient([0]);
    const log = fakeLog();
    broadcastToClients([client], "status", { ok: true }, log);
    expect(client.closed).toBe(true);
    expect(log.warns.length).toBe(1);
  });

  test("a send() returning -1 (backpressure) is tolerated for a few sends before closing", () => {
    const client = fakeClient([-1, -1, -1, -1]);
    const log = fakeLog();
    broadcastToClients([client], "a", {}, log);
    expect(client.closed).toBe(false);
    broadcastToClients([client], "b", {}, log);
    expect(client.closed).toBe(false);
    broadcastToClients([client], "c", {}, log);
    // third consecutive backpressure event closes the client
    expect(client.closed).toBe(true);
  });

  test("a successful send resets the backpressure counter", () => {
    const client = fakeClient([-1, -1, 99, -1, -1, -1]);
    const log = fakeLog();
    broadcastToClients([client], "a", {}, log); // -1 (count=1)
    broadcastToClients([client], "b", {}, log); // -1 (count=2)
    broadcastToClients([client], "c", {}, log); // 99 -- resets to 0
    expect(client.closed).toBe(false);
    broadcastToClients([client], "d", {}, log); // -1 (count=1)
    broadcastToClients([client], "e", {}, log); // -1 (count=2)
    expect(client.closed).toBe(false);
    broadcastToClients([client], "f", {}, log); // -1 (count=3) -- closes
    expect(client.closed).toBe(true);
  });

  test("a client whose send() throws is treated as gone: caught, not propagated", () => {
    const client: BroadcastTarget = {
      send() { throw new Error("ECONNRESET"); },
      close() { /* no-op */ },
    };
    expect(() => broadcastToClients([client], "a", {}, fakeLog())).not.toThrow();
  });
});
