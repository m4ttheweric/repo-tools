import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { subscribeHerdrEvents, type HerdrEvent } from "../subscribe.ts";

const log = { warn: () => {}, debug: () => {} };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

/**
 * A streaming fake: acks the subscribe line, then pushes whatever the test
 * hands it. An explicit `sockPath` lets a test bring the fake up at a path a
 * subscription is already retrying against.
 */
function streamingHerdr(sockPath?: string) {
  const dir = sockPath ? undefined : mkdtempSync(join(tmpdir(), "fake-herdr-stream-"));
  const sock = sockPath ?? join(dir!, "s.sock");
  const sockets: Array<{ write(s: string | Uint8Array): void; end(): void }> = [];
  const requests: string[] = [];
  const server = Bun.listen({
    unix: sock,
    socket: {
      open(s) { sockets.push(s); },
      data(s, chunk) {
        const line = chunk.toString().trim();
        requests.push(line);
        const req = JSON.parse(line) as { id: string };
        s.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
      },
      close() {},
      error() {},
    },
  });
  cleanups.push(() => { server.stop(true); if (dir) rmSync(dir, { recursive: true, force: true }); });
  return {
    sock, requests,
    push(ev: object) { for (const s of sockets) s.write(JSON.stringify(ev) + "\n"); },
    writeRaw(s: string | Uint8Array) { for (const sock of sockets) sock.write(s); },
    dropAll() { for (const s of sockets.splice(0)) s.end(); },
  };
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() > deadline) throw new Error("timeout"); await Bun.sleep(10); }
}

describe("subscribeHerdrEvents", () => {
  test("sends the subscribe request, reports connected, delivers pushed events, ignores the ack", async () => {
    const fake = streamingHerdr();
    const events: HerdrEvent[] = [];
    const states: boolean[] = [];
    const sub = subscribeHerdrEvents({ sockPath: fake.sock, subscriptions: [{ type: "pane.closed" }], onEvent: (e) => events.push(e), onState: (c) => states.push(c), log });
    cleanups.push(() => sub.stop());
    await until(() => sub.connected());
    expect(JSON.parse(fake.requests[0]!)).toMatchObject({ method: "events.subscribe", params: { subscriptions: [{ type: "pane.closed" }] } });
    fake.push({ event: "pane_closed", data: { pane_id: "w1:p1", type: "pane_closed", workspace_id: "w1" } });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: "pane.closed", pane_id: "w1:p1", workspace_id: "w1" });
    expect(states[0]).toBe(true);
  });

  test("reconnects with backoff after the server drops the connection", async () => {
    const fake = streamingHerdr();
    const events: HerdrEvent[] = [];
    const sub = subscribeHerdrEvents({ sockPath: fake.sock, subscriptions: [{ type: "pane.closed" }], onEvent: (e) => events.push(e), log, backoffMs: { initial: 20, max: 50 } });
    cleanups.push(() => sub.stop());
    await until(() => sub.connected());
    fake.dropAll();
    await until(() => !sub.connected());
    await until(() => fake.requests.length === 2);
    await until(() => sub.connected());
    fake.push({ event: "pane_exited", data: { pane_id: "w1:p2", type: "pane_exited", workspace_id: "w1" } });
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: "pane.exited", pane_id: "w1:p2" });
  });

  test("a missing socket is not connected and keeps retrying until the socket appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-herdr-"));
    const sock = join(dir, "none.sock");
    const sub = subscribeHerdrEvents({ sockPath: sock, subscriptions: [], onEvent: () => {}, log, backoffMs: { initial: 10, max: 20 } });
    cleanups.push(() => sub.stop());
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await Bun.sleep(60);
    expect(sub.connected()).toBe(false);
    const fake = streamingHerdr(sock);
    await until(() => sub.connected());
    expect(fake.requests.length).toBe(1);
  });

  test("stop before the ack lands leaves no subscription behind", async () => {
    const fake = streamingHerdr();
    const states: boolean[] = [];
    const sub = subscribeHerdrEvents({ sockPath: fake.sock, subscriptions: [], onEvent: () => {}, onState: (c) => states.push(c), log, backoffMs: { initial: 10, max: 20 } });
    sub.stop();
    await Bun.sleep(50);
    expect(sub.connected()).toBe(false);
    expect(states).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  test("a partial line across chunks is reassembled, multibyte character included", async () => {
    const fake = streamingHerdr();
    const events: HerdrEvent[] = [];
    const sub = subscribeHerdrEvents({ sockPath: fake.sock, subscriptions: [], onEvent: (e) => events.push(e), log });
    cleanups.push(() => sub.stop());
    await until(() => sub.connected());
    const message = "pane ✓ closed";
    const line = JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent: "spike-bot", agent_status: "blocked", message, workspace_id: "w1" } }) + "\n";
    const bytes = Buffer.from(line, "utf8");
    const tick = bytes.indexOf(Buffer.from("✓", "utf8"));
    expect(tick).toBeGreaterThan(0);
    const cut = tick + 1;
    fake.writeRaw(bytes.subarray(0, cut));
    await Bun.sleep(5);
    fake.writeRaw(bytes.subarray(cut));
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: "pane.agent_status_changed", pane_id: "w1:p1", agent_status: "blocked", message });
  });
});
