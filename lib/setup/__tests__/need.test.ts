import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPERS_DIR, __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { setSetting } from "../../settings/write.ts";
import { awaitNeed, servicePlists, SERVICE_PLISTS } from "../need.ts";
import { fakeProbes, fakeTray } from "./fakes.ts";

const DECK_LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    {
      name: "deck",
      version: "1.0.0",
      license: "MIT",
      url: "https://x/deck.tar.gz",
      sha256: "d".repeat(64),
      archive: "tar.gz",
      extract: "deck",
      bundlePath: `${HELPERS_DIR}/deck`,
      exec: [`${HELPERS_DIR}/deck`],
      exposeByDefault: false,
      entitlements: "none",
      status: "bundled",
      kind: "helper",
    },
  ],
};

describe("servicePlists", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-need-home-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  test("deck bundled -> daemon + deck, flavored by mode", () => {
    const appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-need-app-"))), "mattstack.app");
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(appRoot, HELPERS_DIR), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify(DECK_LOCK));
    writeFileSync(join(appRoot, HELPERS_DIR, "deck"), "deck-binary");
    setSetting("mattstack.appPath", appRoot, "machine");

    const deckPath = join(appRoot, HELPERS_DIR, "deck");
    const p = fakeProbes({ home, files: { [deckPath]: "deck-binary" }, dirs: { [appRoot]: [] } });

    expect(servicePlists("dev", p)).toEqual({ plists: ["com.mattstack.daemon.dev.plist", "com.mattstack.deck.dev.plist"], deckOmitted: false });
    expect(servicePlists("prod", p)).toEqual({ plists: ["com.mattstack.daemon.plist", "com.mattstack.deck.plist"], deckOmitted: false });
  });

  test("deck not bundled -> daemon only, deckOmitted true", () => {
    const p = fakeProbes({ home });
    expect(servicePlists("dev", p)).toEqual({ plists: ["com.mattstack.daemon.dev.plist"], deckOmitted: true });
    expect(servicePlists("prod", p)).toEqual({ plists: ["com.mattstack.daemon.plist"], deckOmitted: true });
  });

  test("SERVICE_PLISTS names the prod-flavor pair", () => {
    expect(SERVICE_PLISTS).toEqual(["com.mattstack.daemon.plist", "com.mattstack.deck.plist"]);
  });
});

function fakeClock(startMs = 0) {
  let elapsed = startMs;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms;
    },
  };
}

describe("awaitNeed", () => {
  test("done after two pending polls", async () => {
    let calls = 0;
    const tray = fakeTray({
      "GET /setup/need/services.register": () => {
        calls += 1;
        if (calls < 3) return { status: 200, json: { state: "pending" } };
        return { status: 200, json: { state: "done", detail: "registered" } };
      },
    });
    const { now, sleep } = fakeClock();
    const result = await awaitNeed(tray, "services.register", { timeoutMs: 60_000, pollMs: 1_000, now, sleep });
    expect(result).toEqual({ ok: true, detail: "registered" });
    expect(calls).toBe(3);
  });

  test("failed terminal state maps to ok:false with detail", async () => {
    const tray = fakeTray({
      "GET /setup/need/proxy.install": () => ({ status: 200, json: { state: "failed", detail: "denied" } }),
    });
    const { now, sleep } = fakeClock();
    const result = await awaitNeed(tray, "proxy.install", { now, sleep });
    expect(result).toEqual({ ok: false, detail: "denied" });
  });

  test("a 404 is tolerated as pending, not a failure", async () => {
    let calls = 0;
    const tray = fakeTray({
      "GET /setup/need/services.register": () => {
        calls += 1;
        if (calls === 1) return { status: 404, json: null };
        return { status: 200, json: { state: "done", detail: "registered" } };
      },
    });
    const { now, sleep } = fakeClock();
    const result = await awaitNeed(tray, "services.register", { now, sleep });
    expect(result).toEqual({ ok: true, detail: "registered" });
    expect(calls).toBe(2);
  });

  test('stays pending past the timeout -> "timeout"', async () => {
    const tray = fakeTray({
      "GET /setup/need/services.register": () => ({ status: 200, json: { state: "pending" } }),
    });
    const { now, sleep } = fakeClock();
    const result = await awaitNeed(tray, "services.register", { timeoutMs: 3_000, pollMs: 1_000, now, sleep });
    expect(result).toBe("timeout");
  });

  test('tray unreachable three times in a row -> "app-gone"', async () => {
    let attempts = 0;
    const tray = fakeTray({
      "GET /setup/need/services.register": () => {
        attempts += 1;
        return { status: 0, json: null };
      },
    });
    const { now, sleep } = fakeClock();
    const result = await awaitNeed(tray, "services.register", { timeoutMs: 60_000, pollMs: 1_000, now, sleep });
    expect(result).toBe("app-gone");
    // stops right at the third consecutive miss — never keeps polling toward the full timeout
    expect(attempts).toBe(3);
  });

  test("a reply in between resets the app-gone counter", async () => {
    let attempts = 0;
    const tray = fakeTray({
      "GET /setup/need/services.register": () => {
        attempts += 1;
        if (attempts === 2) return { status: 200, json: { state: "pending" } };
        if (attempts === 5) return { status: 200, json: { state: "done", detail: "registered" } };
        return { status: 0, json: null };
      },
    });
    const { now, sleep } = fakeClock();
    const result = await awaitNeed(tray, "services.register", { timeoutMs: 60_000, pollMs: 1_000, now, sleep });
    expect(result).toEqual({ ok: true, detail: "registered" });
    expect(attempts).toBe(5);
  });

  test("polls an UninstallActionId (EventId, not just StepId) — needed for services.unregister/proxy.remove", async () => {
    const tray = fakeTray({
      "GET /setup/need/services.unregister": () => ({ status: 200, json: { state: "done", detail: "unregistered" } }),
    });
    const { now, sleep } = fakeClock();
    const result = await awaitNeed(tray, "services.unregister", { now, sleep });
    expect(result).toEqual({ ok: true, detail: "unregistered" });
  });
});
