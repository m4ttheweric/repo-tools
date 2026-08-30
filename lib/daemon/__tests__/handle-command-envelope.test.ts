import { test, expect } from "bun:test";
import { createHandleCommand } from "../../daemon.ts";
import { makeSuppressor } from "../command-attribution.ts";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;

function buildHandleCommand(routeCommand: (cmd: string, payload: any, signal?: AbortSignal) => Promise<any>) {
  return createHandleCommand({
    routeCommand,
    ctx: { log: noopLog },
    rejectSuppressor: makeSuppressor(60_000),
    redactDigest: () => ({}),
    currentCmd: { cmd: null },
  });
}

test("a thrown handler yields an additive failure envelope, not a rethrow", async () => {
  const handleCommand = buildHandleCommand(async (cmd) => {
    if (cmd === "boom:verb") throw new Error("kaboom");
    return { ok: true };
  });

  const res = await handleCommand("boom:verb", {});

  expect(res.ok).toBe(false);
  expect(typeof res.error).toBe("string");
  expect(res.failure).toEqual({ code: expect.any(String), message: res.error });
  expect(typeof res.reqId).toBe("string");
});

test("a throw carrying err.code surfaces that code, not the handler-threw fallback", async () => {
  const handleCommand = buildHandleCommand(async () => {
    const err = new Error("nope") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  });

  const res = await handleCommand("some:verb", {});

  expect(res.failure).toEqual({ code: "ENOENT", message: "nope" });
});

test("a throw with no err.code falls back to handler-threw", async () => {
  const handleCommand = buildHandleCommand(async () => {
    throw new Error("plain failure");
  });

  const res = await handleCommand("some:verb", {});

  expect(res.failure).toEqual({ code: "handler-threw", message: "plain failure" });
});

test("a normal ok:true result is untouched, still with no reqId added", async () => {
  const handleCommand = buildHandleCommand(async () => ({ ok: true, data: { hello: "world" } }));

  const res = await handleCommand("some:verb", {});

  expect(res).toEqual({ ok: true, data: { hello: "world" } });
});
