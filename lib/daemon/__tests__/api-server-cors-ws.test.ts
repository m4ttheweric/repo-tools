import { describe, test, expect } from "bun:test";
import { buildCorsHeaders } from "../api-server.ts";

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
