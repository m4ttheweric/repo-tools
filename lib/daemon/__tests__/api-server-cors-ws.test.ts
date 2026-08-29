import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "bun";
import { buildCorsHeaders, startApiServer } from "../api-server.ts";
import { getApiToken } from "../api-auth.ts";
import { setSetting, unsetSetting } from "../../settings/write.ts";

describe("buildCorsHeaders", () => {
  test("no Origin header: no Access-Control-Allow-Origin is set (non-browser request, CORS is irrelevant)", () => {
    const headers = buildCorsHeaders(null, true);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("an untrusted Origin gets no Access-Control-Allow-Origin (default-deny, S006)", () => {
    const headers = buildCorsHeaders("http://evil.example", false);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("a trusted Origin is echoed back with Vary: Origin", () => {
    const headers = buildCorsHeaders("http://localhost:5544", true);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5544");
    expect(headers["Vary"]).toBe("Origin");
  });

  test("always advertises the methods/headers a preflight needs, trusted or not", () => {
    const headers = buildCorsHeaders("http://evil.example", false);
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Headers"]).toContain("X-RT-Token");
  });
});

describe("token-authenticated browser preflight (S-C1: off-allowlist Origin, X-RT-Token preflight)", () => {
  let server: Server<any> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    unsetSetting("rt.apiPort", "user");
  });

  test("an OPTIONS preflight requesting X-RT-Token from an off-allowlist Origin still gets Access-Control-Allow-Origin, so the browser proceeds to the real token-bearing request", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    setSetting("rt.apiPort", port, "user");
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    server = await startApiServer({ handleCommand: async () => ({ ok: true }), log });

    const apiToken = getApiToken();
    const origin = "http://off-allowlist.example";

    const preflight = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-rt-token",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);

    const actual = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: "POST",
      headers: { Origin: origin, "X-RT-Token": apiToken },
    });
    expect(actual.status).not.toBe(401);
    expect(actual.headers.get("access-control-allow-origin")).toBe(origin);
  });
});

describe("advertised URLs use the resolved bind port, not the compile-time default (S9-a)", () => {
  let server: Server<any> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
    unsetSetting("rt.apiPort", "user");
  });

  test("GET / and a 404 both report the actually-bound port when it differs from 9401", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    expect(port).not.toBe(9401);
    setSetting("rt.apiPort", port, "user");
    const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
    server = await startApiServer({ handleCommand: async () => ({ ok: true }), log });

    const root = await (await fetch(`http://127.0.0.1:${port}/`)).json() as { docs: string; websocket: string };
    expect(root.docs).toBe(`http://localhost:${port}/`);
    expect(root.websocket).toBe(`ws://localhost:${port}/ws`);

    const notFound = await (await fetch(`http://127.0.0.1:${port}/nope`)).json() as { docs: string };
    expect(notFound.docs).toBe(`http://localhost:${port}/`);
  });
});
