import { describe, test, expect } from "bun:test";
import type { Server } from "bun";
import { startApiServer, type ApiServerDeps } from "../api-server.ts";
import { getApiToken } from "../api-auth.ts";
import { setSetting, unsetSetting } from "../../settings/write.ts";

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

/** A genuinely free port, released immediately so startApiServer binds it back. */
async function ephemeralPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun.serve did not report a bound port");
  return port;
}

/**
 * Starts a real server on a fresh ephemeral port with the given fake
 * handleCommand, runs `run` against it, and always tears down the server and
 * the port setting afterward, even when an assertion inside `run` throws.
 */
async function withApiServer(
  handleCommand: ApiServerDeps["handleCommand"],
  run: (port: number) => Promise<void>,
): Promise<void> {
  const port = await ephemeralPort();
  setSetting("rt.apiPort", port, "user");
  let server: Server<any> | undefined;
  try {
    server = await startApiServer({ handleCommand, log: noopLog });
    expect(server.port).toBe(port);
    await run(port);
  } finally {
    server?.stop(true);
    unsetSetting("rt.apiPort", "user");
  }
}

describe("startApiServer: routing dispatch", () => {
  test("a GET route reaches handleCommand with the mapped cmd and a query-derived payload", async () => {
    const calls: Array<{ cmd: string; payload: any }> = [];
    const handleCommand: ApiServerDeps["handleCommand"] = async (cmd, payload) => {
      calls.push({ cmd, payload });
      return { ok: true, data: "repos-list" };
    };
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/repos`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, data: "repos-list" });
      expect(calls).toEqual([{ cmd: "repos", payload: {} }]);
    });
  });
});

describe("startApiServer: token gate", () => {
  test("a gated POST route without a token is rejected before reaching handleCommand", async () => {
    const calls: string[] = [];
    const handleCommand: ApiServerDeps["handleCommand"] = async (cmd) => {
      calls.push(cmd);
      return { ok: true };
    };
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
      expect(calls).toEqual([]);
    });
  });

  test("the same gated route with the correct X-RT-Token dispatches to handleCommand", async () => {
    const calls: string[] = [];
    const handleCommand: ApiServerDeps["handleCommand"] = async (cmd) => {
      calls.push(cmd);
      return { ok: true, data: "refreshed" };
    };
    await withApiServer(handleCommand, async (port) => {
      const token = getApiToken();
      const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
        method: "POST",
        headers: { "X-RT-Token": token },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, data: "refreshed" });
      expect(calls).toEqual(["cache:refresh"]);
    });
  });
});

describe("startApiServer: CORS default-deny", () => {
  test("a foreign Origin gets no Access-Control-Allow-Origin header", async () => {
    const handleCommand: ApiServerDeps["handleCommand"] = async () => ({ ok: true });
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Origin: "http://evil.example" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });
});

describe("startApiServer: WS origin guard", () => {
  test("a foreign Origin on the /ws path is rejected before any upgrade is attempted", async () => {
    const handleCommand: ApiServerDeps["handleCommand"] = async () => ({ ok: true });
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/ws`, {
        headers: { Origin: "http://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("origin not allowed");
    });
  });
});

describe("startApiServer: envelope shapes", () => {
  test("an unknown path returns the 404 envelope with docs", async () => {
    const handleCommand: ApiServerDeps["handleCommand"] = async () => ({ ok: true });
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/nope`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        ok: false,
        error: "not found",
        docs: `http://localhost:${port}/`,
      });
    });
  });

  test("a known path called with the wrong method returns the 405 envelope naming the right one", async () => {
    const handleCommand: ApiServerDeps["handleCommand"] = async () => ({ ok: true });
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/refresh`);
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ ok: false, error: "use POST" });
    });
  });

  test("a handleCommand throw returns 500 with the additive failure envelope (R035)", async () => {
    const handleCommand: ApiServerDeps["handleCommand"] = async () => {
      throw Object.assign(new Error("kaboom"), { code: "boom-code" });
    };
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(res.status).toBe(500);
      const body = await res.json() as { ok: boolean; error: string; failure: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("kaboom");
      expect(body.failure).toEqual({ code: "boom-code", message: "kaboom" });
    });
  });

  test("a thrown error with no .code falls back to the handler-threw failure code", async () => {
    const handleCommand: ApiServerDeps["handleCommand"] = async () => {
      throw new Error("plain failure");
    };
    await withApiServer(handleCommand, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(res.status).toBe(500);
      const body = await res.json() as { failure: { code: string; message: string } };
      expect(body.failure).toEqual({ code: "handler-threw", message: "plain failure" });
    });
  });
});

describe("startApiServer: client disconnect", () => {
  test("aborting the client fetch fires the AbortSignal handleCommand received", async () => {
    let handlerSignal: AbortSignal | undefined;
    let aborted = false;
    let resolveStarted: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });

    const handleCommand: ApiServerDeps["handleCommand"] = async (_cmd, _payload, signal) => {
      handlerSignal = signal;
      resolveStarted();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => { aborted = true; resolve(); });
      });
      return { ok: true };
    };

    await withApiServer(handleCommand, async (port) => {
      const controller = new AbortController();
      const req = fetch(`http://127.0.0.1:${port}/api/status`, { signal: controller.signal }).catch(() => {});
      await started;
      controller.abort();
      await req;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(handlerSignal?.aborted).toBe(true);
      expect(aborted).toBe(true);
    });
  });
});
