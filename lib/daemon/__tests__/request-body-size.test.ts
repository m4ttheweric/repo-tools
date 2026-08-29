/**
 * Bun enforces `maxRequestBodySize` itself (413 before the handler runs) --
 * this is a live-server test, not a pure-function one, because there is no
 * pure function to unit test: the cap is a Bun.serve runtime option.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import { MAX_REQUEST_BODY_SIZE } from "../request-limits.ts";

let server: Server<any> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("MAX_REQUEST_BODY_SIZE", () => {
  test("is set to 1 MiB", () => {
    expect(MAX_REQUEST_BODY_SIZE).toBe(1024 * 1024);
  });

  test("Bun rejects a body over the cap with a 4xx before the handler runs", async () => {
    let handlerRan = false;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      maxRequestBodySize: 10, // tiny cap for a fast, deterministic test
      async fetch(req) {
        handlerRan = true;
        await req.text();
        return new Response("ok");
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/`, {
      method: "POST",
      body: "x".repeat(1000),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(handlerRan).toBe(false);
  });
});
