/**
 * API auth unit tests — pure helpers deciding which :9401 requests require the
 * local token and whether a presented token is valid. No server.
 */

import { describe, test, expect } from "bun:test";
import { needsToken, tokenOk, getApiToken, reloadApiToken, loadOrCreateApiToken } from "../api-auth.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("needsToken", () => {
  test("shutdown requires a token", () => {
    expect(needsToken("POST", "/api/shutdown")).toBe(true);
  });

  test("reads do not require a token", () => {
    expect(needsToken("GET", "/api/repos")).toBe(false);
    expect(needsToken("GET", "/")).toBe(false);
  });

  test("preflight (OPTIONS) never requires a token", () => {
    expect(needsToken("OPTIONS", "/api/shutdown")).toBe(false);
  });

  test("sdm reconnect requires a token", () => {
    expect(needsToken("POST", "/api/sdm/reconnect")).toBe(true);
  });

  test("sdm recents does not require a token", () => {
    expect(needsToken("GET", "/api/sdm/recents")).toBe(false);
  });

  test("events emit requires a token", () => {
    expect(needsToken("POST", "/api/events/emit")).toBe(true);
  });

  test("events list does not require a token", () => {
    expect(needsToken("GET", "/api/events")).toBe(false);
  });

  test("secrets requires a token even though it's a GET — the response body is a credential, not metadata", () => {
    expect(needsToken("GET", "/api/secrets")).toBe(true);
  });
});

describe("tokenOk", () => {
  test("matches the expected token", () => {
    expect(tokenOk("secret", "secret")).toBe(true);
  });

  test("rejects a wrong token", () => {
    expect(tokenOk("nope", "secret")).toBe(false);
  });

  test("rejects a missing token", () => {
    expect(tokenOk(null, "secret")).toBe(false);
  });

  test("rejects when no expected token is configured", () => {
    expect(tokenOk("anything", "")).toBe(false);
  });
});

describe("getApiToken / reloadApiToken singleton", () => {
  test("getApiToken caches: a second call does not re-read the file even if it changes underneath", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-api-token-"));
    const tokenPath = join(dir, "api-token");
    try {
      const first = reloadApiToken(tokenPath); // seed the cache with a known path
      writeFileSync(tokenPath, "a-different-token", { mode: 0o600 });
      const second = getApiToken(tokenPath); // ignores the new file content -- cached
      expect(second).toBe(first);
      expect(second).not.toBe("a-different-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reloadApiToken re-reads and updates the cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-api-token-"));
    const tokenPath = join(dir, "api-token");
    try {
      reloadApiToken(tokenPath);
      writeFileSync(tokenPath, "rotated-token", { mode: 0o600 });
      const reloaded = reloadApiToken(tokenPath);
      expect(reloaded).toBe("rotated-token");
      expect(getApiToken(tokenPath)).toBe("rotated-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loadOrCreateApiToken still works standalone (unchanged primitive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-api-token-"));
    const tokenPath = join(dir, "api-token");
    try {
      const a = loadOrCreateApiToken(tokenPath);
      const b = loadOrCreateApiToken(tokenPath);
      expect(a).toBe(b);
      expect(a.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
