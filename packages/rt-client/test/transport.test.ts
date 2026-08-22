import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rtCommand } from "../src/transport.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

describe("rtCommand", () => {
  test("POSTs payload to /<cmd> and returns the daemon envelope", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "project-mrs:read": { ok: true, data: { mrs: {}, listSyncedAt: 5, source: "poll", syncedAt: 5 } },
    });
    stops.push(stop);
    const res = await rtCommand("project-mrs:read", { repoName: "x" }, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen).toEqual([{ cmd: "project-mrs:read", payload: { repoName: "x" } }]);
  });

  test("unreachable socket returns ok:false with an instructive error, never throws", async () => {
    const sockPath = join(tmpdir(), "definitely-missing.sock");
    const res = await rtCommand("project-mrs:read", { repoName: "x" }, { sockPath });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`rt daemon unreachable at ${sockPath}`);
  });

  test("timeout is honored: a slow daemon yields ok:false instead of hanging", async () => {
    // A dedicated slow server (not fakeDaemon, whose replies are instant) so
    // the 20ms timeout vs 200ms response delay margin is never racy.
    const sock = join(tmpdir(), `rt-client-timeout-test-${process.pid}.sock`);
    const server = Bun.serve({
      unix: sock,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return Response.json({ ok: true, data: {} });
      },
    });
    stops.push(() => server.stop(true));
    const res = await rtCommand("slow-cmd", {}, { sockPath: sock, timeoutMs: 20 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`rt daemon unreachable at ${sock}`);
  });

  test("no sockPath resolves the default at call time from process.env.HOME, not a module-load snapshot", async () => {
    const origHome = process.env.HOME;
    const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "rt-client-transport-home-")));
    process.env.HOME = fakeHome;
    try {
      const res = await rtCommand("project-mrs:read", { repoName: "x" }, {});
      expect(res.ok).toBe(false);
      expect(res.error).toContain(join(fakeHome, ".mattstack", "rt", "rt.sock"));
    } finally {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
