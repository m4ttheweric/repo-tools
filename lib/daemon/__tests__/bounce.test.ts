import { test, expect } from "bun:test";
import { resolveBounce } from "../bounce.ts";

const ALLOWED = new Set(["http://localhost:5544", "https://app.example.com"]);

test("redirects back to the return origin, dropping the return param but keeping other query params", () => {
  const result = resolveBounce(
    "http://localhost:9000/callback?code=abc&state=xyz&rt_return=" + encodeURIComponent("http://localhost:5544/finish"),
    "rt_return",
    ALLOWED,
  );
  expect(result.status).toBe(302);
  expect(result.location).toBe("http://localhost:5544/callback?code=abc&state=xyz");
});

test("rejects a return origin not in the allowlist (open-redirect guard)", () => {
  const result = resolveBounce(
    "http://localhost:9000/callback?rt_return=" + encodeURIComponent("http://evil.example.com/steal"),
    "rt_return",
    ALLOWED,
  );
  expect(result.status).toBe(400);
  expect(result.body).toBe("return origin not allowed");
  expect(result.location).toBeUndefined();
});

test("400s when the return param is missing entirely", () => {
  const result = resolveBounce("http://localhost:9000/callback?code=abc", "rt_return", ALLOWED);
  expect(result.status).toBe(400);
  expect(result.body).toBe("missing rt_return");
});

test("400s when the request url itself cannot be parsed", () => {
  const result = resolveBounce("not a url", "rt_return", ALLOWED);
  expect(result.status).toBe(400);
  expect(result.body).toBe("bad request url");
});

test("400s when the return value is not a parseable url", () => {
  const result = resolveBounce("http://localhost:9000/callback?rt_return=not-a-url", "rt_return", ALLOWED);
  expect(result.status).toBe(400);
  expect(result.body).toBe("bad return origin");
});

test("honors a non-default return param name", () => {
  const result = resolveBounce(
    "http://localhost:9000/callback?return_to=" + encodeURIComponent("https://app.example.com/done"),
    "return_to",
    ALLOWED,
  );
  expect(result.status).toBe(302);
  // The return value's own path ("/done") is discarded -- only its origin is
  // trusted; the redirect keeps the original request's pathname.
  expect(result.location).toBe("https://app.example.com/callback");
});

test("drops the whole query string when the return param was the only param", () => {
  const result = resolveBounce(
    "http://localhost:9000/callback?rt_return=" + encodeURIComponent("http://localhost:5544/finish"),
    "rt_return",
    ALLOWED,
  );
  expect(result.status).toBe(302);
  expect(result.location).toBe("http://localhost:5544/callback");
});
