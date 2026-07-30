import { describe, test, expect } from "bun:test";
import {
  buildConnectionsJson,
  buildConnectionsRefusal,
  buildConnectJson,
  buildProductionRefusal,
  buildStatusJson,
} from "../agent-json.ts";
import type { SdmConnection } from "../browse.ts";
import type { SdmResourceState, SdmSnapshot } from "../core.ts";
import type { GuidedTarget } from "../flow.ts";

const CONN: SdmConnection = {
  key: "sdm:stg-rw",
  label: "staging read-write",
  sdmResource: "stg-rw",
  tier: "staging",
  production: false,
  reasonSuggestion: "investigating staging data",
  db: { database: "assured", schema: "public" },
  standingAccess: false,
};

const STATE = new Map<string, SdmResourceState>([
  ["stg-rw", { connected: true, address: "127.0.0.1:15432", expiry: "4:12PM" }],
]);

describe("buildConnectionsJson", () => {
  test("joins scan rows with live state and carries the duration contract", () => {
    const body = buildConnectionsJson([CONN], STATE) as any;
    expect(body.ok).toBe(true);
    expect(body.durations).toEqual(["8h", "4h", "1h"]);
    expect(body.defaultDuration).toBe("8h");
    expect(body.connections).toEqual([
      {
        key: "sdm:stg-rw",
        label: "staging read-write",
        sdmResource: "stg-rw",
        tier: "staging",
        production: false,
        standingAccess: false,
        connected: true,
        address: "127.0.0.1:15432",
        defaultReason: "investigating staging data",
        db: { database: "assured", schema: "public" },
      },
    ]);
  });

  test("a resource with no live state reads disconnected, and missing enrichment gets safe defaults", () => {
    const bare: SdmConnection = { key: "sdm:x", label: "x", sdmResource: "x", reasonSuggestion: "investigating x data" };
    const body = buildConnectionsJson([bare], new Map()) as any;
    expect(body.connections[0]).toMatchObject({
      connected: false,
      address: null,
      tier: null,
      production: false,
      standingAccess: false,
      db: null,
    });
  });
});

describe("buildConnectionsRefusal", () => {
  test("carries health and error with ok:false", () => {
    expect(buildConnectionsRefusal({ status: "not-authenticated", message: "run sdm login" })).toEqual({
      ok: false,
      health: "not-authenticated",
      error: "run sdm login",
    });
    expect(buildConnectionsRefusal({ status: "ok", message: null }, "scan failed")).toEqual({
      ok: false,
      health: "ok",
      error: "scan failed",
    });
  });
});

const TARGET: GuidedTarget = {
  key: "sdm:stg-rw",
  label: "staging read-write",
  sdmResource: "stg-rw",
  db: { database: "assured", schema: "public" },
};

describe("buildConnectJson", () => {
  test("connected: address, url, db facts, verify facts, exit 0", () => {
    const { json, exitCode } = buildConnectJson(TARGET, {
      outcome: "connected",
      address: "127.0.0.1:15432",
      verify: { ok: true, attempts: 2, latencyMs: 812, lastError: null },
    });
    expect(exitCode).toBe(0);
    expect(json).toEqual({
      ok: true,
      address: "127.0.0.1:15432",
      url: "postgres://postgres@127.0.0.1:15432/assured",
      database: "assured",
      schema: "public",
      verified: true,
      latencyMs: 812,
      attempts: 2,
    });
  });

  test("unverified tunnel reports verified:false but still ok", () => {
    const { json, exitCode } = buildConnectJson(TARGET, {
      outcome: "connected",
      address: "127.0.0.1:15432",
      unverified: true,
      verify: { ok: false, attempts: 5, latencyMs: null, lastError: new Error("Connection closed") },
    });
    expect(exitCode).toBe(0);
    expect((json as any).ok).toBe(true);
    expect((json as any).verified).toBe(false);
  });

  test("failed: stage, error, hint, exit 1", () => {
    const { json, exitCode } = buildConnectJson(TARGET, {
      outcome: "failed",
      stage: "login",
      error: "Not authenticated.",
      hint: "Run `rt sdm login`, then retry.",
    });
    expect(exitCode).toBe(1);
    expect(json).toEqual({ ok: false, stage: "login", error: "Not authenticated.", hint: "Run `rt sdm login`, then retry." });
  });

  test("aborted maps to stage aborted", () => {
    const { json, exitCode } = buildConnectJson(TARGET, { outcome: "aborted", reason: "login declined" });
    expect(exitCode).toBe(1);
    expect(json).toEqual({ ok: false, stage: "aborted", error: "login declined", hint: null });
  });
});

describe("buildProductionRefusal", () => {
  test("names the target and the flag", () => {
    const body = buildProductionRefusal({ ...TARGET, production: true }) as any;
    expect(body.ok).toBe(false);
    expect(body.stage).toBe("confirm");
    expect(body.error).toContain("staging read-write");
    expect(body.error).toContain("--confirm-production");
  });
});

describe("buildStatusJson", () => {
  test("healthy: tunnels listed, exit 0", () => {
    const snapshot: SdmSnapshot = {
      health: { status: "ok", message: null },
      resources: new Map([
        ["stg-rw", { connected: true, address: "127.0.0.1:15432", expiry: "4:12PM" }],
        ["idle", { connected: false, address: null, expiry: null }],
      ]),
    };
    const { json, exitCode } = buildStatusJson(snapshot, true);
    expect(exitCode).toBe(0);
    expect(json).toEqual({
      ok: true,
      health: "ok",
      message: null,
      appRunning: true,
      tunnels: [{ resource: "stg-rw", address: "127.0.0.1:15432", expiry: "4:12PM" }],
    });
  });

  test("unhealthy: ok false, empty tunnels, exit 1", () => {
    const snapshot: SdmSnapshot = {
      health: { status: "not-authenticated", message: "run sdm login" },
      resources: new Map(),
    };
    const { json, exitCode } = buildStatusJson(snapshot, false);
    expect(exitCode).toBe(1);
    expect(json).toEqual({ ok: false, health: "not-authenticated", message: "run sdm login", appRunning: false, tunnels: [] });
  });
});
