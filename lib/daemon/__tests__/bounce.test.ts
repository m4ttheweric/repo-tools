import { describe, test, expect } from "bun:test";
import { resolveBounce } from "../bounce.ts";

const ALLOWED = new Set(["https://portal.localhost"]);

describe("resolveBounce", () => {
  test("302s to the return origin, preserving path + other query, dropping the return param", () => {
    const r = resolveBounce(
      "http://localhost:4001/callback?rt_return=https%3A%2F%2Fportal.localhost&code=abc&state=xyz",
      "rt_return", ALLOWED);
    expect(r.status).toBe(302);
    expect(r.location).toBe("https://portal.localhost/callback?code=abc&state=xyz");
  });
  test("400 when the return param is missing", () => {
    const r = resolveBounce("http://localhost:4001/callback?code=abc", "rt_return", ALLOWED);
    expect(r.status).toBe(400);
    expect(r.location).toBeUndefined();
  });
  test("400 when the return origin is not in the allowlist (open-redirect guard)", () => {
    const r = resolveBounce(
      "http://localhost:4001/callback?rt_return=https%3A%2F%2Fevil.example.com&code=abc",
      "rt_return", ALLOWED);
    expect(r.status).toBe(400);
  });
  test("preserves the request path other than /callback", () => {
    const r = resolveBounce(
      "http://localhost:4001/auth/cb?rt_return=https%3A%2F%2Fportal.localhost&code=1",
      "rt_return", ALLOWED);
    expect(r.location).toBe("https://portal.localhost/auth/cb?code=1");
  });
});
