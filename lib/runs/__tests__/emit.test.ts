import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import { DAEMON_SOCK_PATH } from "../../daemon-config.ts";
import { emitRunUpdated } from "../emit.ts";

const update = { repo: "demo", runId: "r1", stage: "plan", kind: "stage-done" };

describe("emitRunUpdated", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
  });

  test("posts events:emit with the run-updated topic and payload", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    let seen: { path: string; body: unknown } | null = null;
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      async fetch(req) {
        seen = { path: new URL(req.url).pathname, body: await req.json() };
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
    await emitRunUpdated(update, {});
    expect(seen).toEqual({ path: "/events:emit", body: { topic: "run-updated", payload: update } });
  });

  test("RT_RUN_EMIT=0 sends nothing", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    let hits = 0;
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      fetch() { hits++; return new Response(JSON.stringify({ ok: true })); },
    });
    await emitRunUpdated(update, { RT_RUN_EMIT: "0" });
    expect(hits).toBe(0);
  });

  test("no socket returns at once", async () => {
    if (existsSync(DAEMON_SOCK_PATH)) rmSync(DAEMON_SOCK_PATH);
    const t0 = performance.now();
    await emitRunUpdated(update, {});
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test("a daemon that accepts and never answers costs at most the timeout", async () => {
    mkdirSync(dirname(DAEMON_SOCK_PATH), { recursive: true });
    server = Bun.serve({
      unix: DAEMON_SOCK_PATH,
      async fetch() { await new Promise(() => {}); return new Response(); },
    });
    const t0 = performance.now();
    await emitRunUpdated(update, {}, 300);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  });
});
