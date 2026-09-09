import { test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname } from "path";
import { TRAY_SOCK_PATH } from "../daemon-config.ts";
import { trayQuery } from "../daemon-client.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(TRAY_SOCK_PATH, { force: true });
});

/** trayQuery bails before fetching unless the socket path exists. */
function fakeTraySocket(): void {
  mkdirSync(dirname(TRAY_SOCK_PATH), { recursive: true });
  writeFileSync(TRAY_SOCK_PATH, "");
}

test("trayQuery identifies itself, so the tray can log who asked for a restart", async () => {
  // The 2026-09-09 incident: the tray logged `daemon kickstarted` with no way
  // to tell a gear-menu click from a CLI POST, because this request carried no
  // X-RT-Client the way every other rt socket client does.
  fakeTraySocket();
  let seen: Record<string, string> | undefined;
  globalThis.fetch = (async (_url: string, init: any) => {
    seen = init.headers;
    return new Response(JSON.stringify({ ok: true }));
  }) as any;

  await trayQuery("/daemon/restart", "POST");

  expect(seen?.["X-RT-Client"]).toBe(`rt-cli/${process.pid}`);
});
