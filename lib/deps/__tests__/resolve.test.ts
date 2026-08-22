import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HELPERS_DIR, RT_BUNDLE_PATH, __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { setSetting } from "../../settings/write.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { appBundlePath, bundledToolExec, bundledToolPath, resolveTool, userCopyOnPath } from "../resolve.ts";

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    {
      name: "gh", version: "2.0.0", license: "MIT", url: "https://x/gh.tar.gz", sha256: "a".repeat(64),
      archive: "tar.gz", extract: "gh", bundlePath: `${HELPERS_DIR}/gh`, exec: [`${HELPERS_DIR}/gh`],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper",
    },
    {
      name: "fast-browser", version: "0.1.0", license: "MIT", url: "https://x/fb.tgz", sha256: "b".repeat(64),
      archive: "npm", extract: "package", bundlePath: `${HELPERS_DIR}/fast-browser`,
      exec: [`${HELPERS_DIR}/node/bin/node`, `${HELPERS_DIR}/fast-browser/bin/fast-browser.mjs`],
      exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper",
    },
  ],
};

describe("bundled-tool resolution", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-home-")));
    process.env.HOME = home;

    appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-deps-app-"))), "mattstack.app");
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify(LOCK));

    setSetting("mattstack.appPath", appRoot, "machine");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  // Every path under appRoot is treated as present without writing the real
  // binary — only deps.lock itself needs to be a real file (readDepsLock
  // reads it directly, unmediated by the exists probe).
  function existsUnderApp(...extra: string[]): (p: string) => boolean {
    const known = new Set([appRoot, join(appRoot, RT_BUNDLE_PATH), ...extra]);
    return (p: string) => known.has(p);
  }

  test("appBundlePath resolves the seeded mattstack.appPath", () => {
    const p = fakeProbes({ home, env: {} });
    const probe = { ...p, exists: existsUnderApp() };
    expect(appBundlePath(probe)).toBe(appRoot);
  });

  test("bundledToolPath resolves gh and rt", () => {
    const ghPath = join(appRoot, HELPERS_DIR, "gh");
    const probe = { ...fakeProbes({ home }), exists: existsUnderApp(ghPath) };
    expect(bundledToolPath(probe, "gh")).toBe(ghPath);
    expect(bundledToolPath(probe, "rt")).toBe(join(appRoot, RT_BUNDLE_PATH));
  });

  test("bundledToolExec returns the multi-entry argv for fast-browser; resolveTool mirrors it", () => {
    const nodePath = join(appRoot, HELPERS_DIR, "node", "bin", "node");
    const fbPath = join(appRoot, HELPERS_DIR, "fast-browser", "bin", "fast-browser.mjs");
    const probe = { ...fakeProbes({ home }), exists: existsUnderApp(nodePath, fbPath) };

    const exec = bundledToolExec(probe, "fast-browser");
    expect(exec).toEqual([nodePath, fbPath]);

    const resolution = resolveTool(probe, "fast-browser");
    expect(resolution.exec).toEqual(exec);
    expect(resolution.bundled).toBe(nodePath);
  });

  test("userCopyOnPath finds a real copy on PATH", () => {
    const probe = {
      ...fakeProbes({ home, env: { PATH: "/opt/homebrew/bin:/Users/x/.local/bin" } }),
      exists: (p: string) => p === "/opt/homebrew/bin/gh",
      readlink: () => null,
    };
    expect(userCopyOnPath(probe, "gh")).toBe("/opt/homebrew/bin/gh");
  });

  test("userCopyOnPath returns null when the only hit is our own link into the bundle", () => {
    const linkedPath = join(home, ".local", "bin", "gh");
    const probe = {
      ...fakeProbes({ home, env: { PATH: `/opt/homebrew/bin:${join(home, ".local", "bin")}` } }),
      exists: (p: string) => p === linkedPath,
      readlink: (p: string) => (p === linkedPath ? join(appRoot, HELPERS_DIR, "gh") : null),
    };
    expect(userCopyOnPath(probe, "gh")).toBeNull();
  });
});
