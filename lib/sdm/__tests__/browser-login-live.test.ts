import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { detectChrome, chromeProfileDir, runBrowserLogin } from "../browser-login.ts";

const live = process.env.RT_SDM_LIVE === "1" && detectChrome(existsSync) !== null && existsSync(chromeProfileDir());

describe.skipIf(!live)("browser-login live", () => {
  test("authenticates against the warmed profile", async () => {
    const r = await runBrowserLogin({ onLine: () => {} });
    expect(r.outcome).toBe("authenticated");
  }, 60_000);
});
