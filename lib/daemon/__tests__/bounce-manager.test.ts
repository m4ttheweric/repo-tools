// lib/daemon/__tests__/bounce-manager.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { BounceManager } from "../bounce-manager.ts";

const mgr = new BounceManager();
afterEach(() => mgr.stopAll?.());

describe("BounceManager", () => {
  test("binds a port and 302s to an allowed origin", async () => {
    const port = 4790;
    mgr.start("t", port, { returnParam: "rt_return", allowedOrigins: () => new Set(["https://app.localhost"]) });
    const res = await fetch(`http://127.0.0.1:${port}/callback?rt_return=${encodeURIComponent("https://app.localhost")}&code=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.localhost/callback?code=1");
    mgr.stop("t");
  });

  test("400s an origin outside the live allowlist", async () => {
    const port = 4791;
    mgr.start("t", port, { returnParam: "rt_return", allowedOrigins: () => new Set<string>() });
    const res = await fetch(`http://127.0.0.1:${port}/callback?rt_return=${encodeURIComponent("https://evil.example")}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    mgr.stop("t");
  });
});
