import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { traySocketPath, trayRequest } from "../daemon-client.ts";

describe("traySocketPath", () => {
  const originalEnv = process.env.RT_APP_SOCKET;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RT_APP_SOCKET;
    else process.env.RT_APP_SOCKET = originalEnv;
  });

  test("RT_APP_SOCKET wins over the default path when set", () => {
    process.env.RT_APP_SOCKET = "/nonexistent.sock";
    expect(traySocketPath()).toBe("/nonexistent.sock");
  });

  test("defaults to ~/.mattstack/rt/tray.sock when unset", () => {
    delete process.env.RT_APP_SOCKET;
    expect(traySocketPath().endsWith("/.mattstack/rt/tray.sock")).toBe(true);
  });
});

describe("trayRequest", () => {
  beforeEach(() => {
    process.env.RT_APP_SOCKET = "/nonexistent.sock";
  });

  afterEach(() => {
    delete process.env.RT_APP_SOCKET;
  });

  test("resolves {status:0, json:null} instead of throwing when the socket is absent", async () => {
    const reply = await trayRequest("/health");
    expect(reply).toEqual({ status: 0, json: null });
  });
});
