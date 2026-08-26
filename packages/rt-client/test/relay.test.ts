import { describe, expect, test, afterEach } from "bun:test";
import { subscribe, createRelay } from "../src/relay.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

describe("subscribe", () => {
  test("receives relay frames and stop() closes cleanly", async () => {
    const events: Array<{ type: string; data: unknown }> = [];
    let sock: Bun.ServerWebSocket<unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: { open(ws) { sock = ws; }, message() {} },
    });
    stops.push(() => server.stop());
    const stop = subscribe((type, data) => events.push({ type, data }), { wsUrl: `ws://127.0.0.1:${server.port}/ws` });
    // Wait for the connection, then push one frame.
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => sock ? resolve() : Date.now() - t0 > 3000 ? reject(new Error("no ws connect")) : setTimeout(poll, 10);
      poll();
    });
    sock!.send(JSON.stringify({ type: "project-mrs", data: { repoName: "r", iids: [1] }, timestamp: 1 }));
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => events.length ? resolve() : Date.now() - t0 > 3000 ? reject(new Error("no event")) : setTimeout(poll, 10);
      poll();
    });
    expect(events[0]).toEqual({ type: "project-mrs", data: { repoName: "r", iids: [1] } });
    stop();
  });

  test("reconnects with backoff on close, and stop() prevents further reconnects", async () => {
    let opens = 0;
    let sock: Bun.ServerWebSocket<unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: { open(ws) { opens++; sock = ws; }, message() {} },
    });
    stops.push(() => server.stop());

    const waitFor = (predicate: () => boolean, deadlineMs: number, message: string) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const poll = () => predicate() ? resolve() : Date.now() - t0 > deadlineMs ? reject(new Error(message)) : setTimeout(poll, 10);
        poll();
      });

    const stop = subscribe(() => {}, { wsUrl: `ws://127.0.0.1:${server.port}/ws` });

    // Initial connection.
    await waitFor(() => opens === 1, 3000, "no initial connect");

    // Server-side close triggers a reconnect (first backoff step is 1s).
    sock!.close();
    await waitFor(() => opens === 2, 5000, "no reconnect after close");

    // stop() first, then close the live socket -- if stop() were broken, this
    // close would trigger another reconnect attempt.
    stop();
    sock!.close();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(opens).toBe(2);
  });
});

describe("createRelay", () => {
  test("republishes only event frames whose topic matches, onto the configured topic", () => {
    const published: Array<[string, string]> = [];
    const cbs: Array<(type: string, data: unknown) => void> = [];
    const stop = createRelay(
      { match: (t) => t.startsWith("chat/"), topic: "chat", publish: (t, d) => published.push([t, d]) },
      { subscribeImpl: (cb) => { cbs.push(cb); return () => {}; } },
    );
    cbs[0]!("event", { topic: "chat/build/msg", payload: { id: 1 } });
    cbs[0]!("event", { topic: "run-updated", payload: {} });
    cbs[0]!("ports", {});
    expect(published).toEqual([["chat", JSON.stringify({ topic: "chat/build/msg", payload: { id: 1 } })]]);
    stop();
  });

  test("stop() delegates to the underlying subscription's unsubscribe", () => {
    let stopped = false;
    const stop = createRelay(
      { match: () => true, topic: "chat", publish: () => {} },
      { subscribeImpl: () => () => { stopped = true; } },
    );
    stop();
    expect(stopped).toBe(true);
  });

  test("a frame missing a string topic is dropped, not thrown on", () => {
    const published: Array<[string, string]> = [];
    const cbs: Array<(type: string, data: unknown) => void> = [];
    const stop = createRelay(
      { match: () => true, topic: "chat", publish: (t, d) => published.push([t, d]) },
      { subscribeImpl: (cb) => { cbs.push(cb); return () => {}; } },
    );
    cbs[0]!("event", {});
    cbs[0]!("event", null);
    expect(published).toEqual([]);
    stop();
  });

  test("defaults subscribeImpl to the real subscribe, wiring through wsUrl", async () => {
    let sock: Bun.ServerWebSocket<unknown> | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: { open(ws) { sock = ws; }, message() {} },
    });
    const published: Array<[string, string]> = [];
    const stop = createRelay(
      { match: (t) => t === "chat/build/msg", topic: "chat", publish: (t, d) => published.push([t, d]) },
      { wsUrl: `ws://127.0.0.1:${server.port}/ws` },
    );
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => sock ? resolve() : Date.now() - t0 > 3000 ? reject(new Error("no ws connect")) : setTimeout(poll, 10);
      poll();
    });
    sock!.send(JSON.stringify({ type: "event", data: { topic: "chat/build/msg", payload: { id: 1 } }, timestamp: 1 }));
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => published.length ? resolve() : Date.now() - t0 > 3000 ? reject(new Error("no publish")) : setTimeout(poll, 10);
      poll();
    });
    expect(published).toEqual([["chat", JSON.stringify({ topic: "chat/build/msg", payload: { id: 1 } })]]);
    stop();
    server.stop();
  });

  test("a publish that throws does not tear down the relay", () => {
    const seen: string[] = [];
    let cb!: (type: string, data: unknown) => void;
    const stop = createRelay(
      {
        match: (t) => t.startsWith("chat/"),
        topic: "chat",
        publish: (_t, d) => {
          if (seen.length === 0) {
            seen.push("threw");
            throw new Error("subscriber went away");
          }
          seen.push(d);
        },
      },
      { subscribeImpl: (fn) => { cb = fn; return () => {}; } },
    );
    cb("event", { topic: "chat/build/msg", payload: { id: 1 } });
    cb("event", { topic: "chat/build/msg", payload: { id: 2 } });
    expect(seen).toEqual(["threw", JSON.stringify({ topic: "chat/build/msg", payload: { id: 2 } })]);
    stop();
  });

});
