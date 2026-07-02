/**
 * API auth unit tests — pure helpers deciding which :9401 requests require the
 * local token and whether a presented token is valid. No server.
 */

import { describe, test, expect } from "bun:test";
import { needsToken, tokenOk } from "../api-auth.ts";

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
