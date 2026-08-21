import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "appcast-"));
writeFileSync(join(dir, "appcast.xml"), "<rss/>");
writeFileSync(join(dir, "mattstack-9.9.9.zip"), "zipbytes");
const port = 18765 + Math.floor(Math.random() * 1000);
const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "appcast-server.ts"), dir, String(port)], {
  stdout: "pipe", stderr: "pipe",
});
afterAll(() => proc.kill());

async function ready() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/appcast.xml`); return; } catch { await Bun.sleep(100); }
  }
  throw new Error("server never came up");
}

describe("appcast-server", () => {
  test("serves files from dir with content types", async () => {
    await ready();
    const r = await fetch(`http://127.0.0.1:${port}/appcast.xml`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/rss+xml");
    expect(await r.text()).toBe("<rss/>");
    const z = await fetch(`http://127.0.0.1:${port}/mattstack-9.9.9.zip`);
    expect(z.status).toBe(200);
    expect(z.headers.get("content-type")).toBe("application/zip");
    expect(z.headers.get("content-length")).toBe("8");
  });
  test("404 for missing and refuses path traversal", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope.xml`)).status).toBe(404);
    // WHATWG URL strips ".." client-side (even %2e-encoded) before the request
    // is ever sent, so a dotted path can only resolve inside `dir` — assert it
    // 404s there rather than leaking content, since it can never reach root.
    expect((await fetch(`http://127.0.0.1:${port}/../secret.txt`)).status).toBe(404);
  });
});
