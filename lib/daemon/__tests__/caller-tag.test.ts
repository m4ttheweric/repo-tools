import { test, expect } from "bun:test";
import { buildCorsHeaders } from "../api-server.ts";

test("CORS allow-headers advertises X-RT-Client so browser preflight passes", () => {
  const h = buildCorsHeaders("https://example.com", true);
  expect(h["Access-Control-Allow-Headers"]).toContain("X-RT-Client");
});
