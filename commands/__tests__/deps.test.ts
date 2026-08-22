import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPERS_DIR, __test__ as bundleLayoutTest } from "../../lib/bundle-layout.ts";
import { setSetting } from "../../lib/settings/write.ts";
import { fakeProbes } from "../../lib/setup/__tests__/fakes.ts";
import { depsResolve } from "../deps.ts";

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    {
      name: "gh", version: "2.0.0", license: "MIT", url: "https://x/gh.tar.gz", sha256: "a".repeat(64),
      archive: "tar.gz", extract: "gh", bundlePath: `${HELPERS_DIR}/gh`, exec: [`${HELPERS_DIR}/gh`],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
    },
  ],
};

describe("rt deps resolve", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;
  let ghPath: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-cmd-home-")));
    process.env.HOME = home;

    appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-cmd-app-"))), "mattstack.app");
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify(LOCK));
    setSetting("mattstack.appPath", appRoot, "machine");

    ghPath = join(appRoot, HELPERS_DIR, "gh");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  test("depsResolve --json prints a contract:1 envelope with the resolved exec array", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const known = new Set([appRoot, ghPath]);
    const p = { ...fakeProbes({ home }), exists: (path: string) => known.has(path) };

    try {
      await depsResolve(["gh", "--json"], {}, p);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs).toHaveLength(1);
    const body = JSON.parse(logs[0]!);
    expect(body.contract).toBe(1);
    expect(typeof body.at).toBe("string");
    expect(body.tool).toBe("gh");
    expect(body.exec).toEqual([ghPath]);
  });
});
