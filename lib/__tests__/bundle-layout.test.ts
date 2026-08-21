import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bundleRootFromExec, bundledExec, bundledHelperPath, parseDepsLock, readDepsLock,
  appBundleRoot, DEPS_LOCK_BUNDLE_PATH, __test__,
} from "../bundle-layout.ts";

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    { name: "fzf", version: "0.74.3", license: "MIT", url: "https://x/fzf.tar.gz", sha256: "a".repeat(64),
      archive: "tar.gz", extract: "fzf", bundlePath: "Contents/Helpers/fzf", exec: ["Contents/Helpers/fzf"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "fast-browser", version: "0.1.0-alpha.11", license: "MIT", url: "https://x/fb.tgz", sha256: "b".repeat(64),
      archive: "npm", extract: "package", bundlePath: "Contents/Helpers/fast-browser",
      exec: ["Contents/Helpers/node/bin/node", "Contents/Helpers/fast-browser/bin/fast-browser.mjs"],
      exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "deck", version: "", license: "MIT", url: "", sha256: "", archive: "raw", extract: "",
      bundlePath: "Contents/Helpers/deck", exec: ["Contents/Helpers/deck"],
      exposeByDefault: true, entitlements: "jit", status: "pending", kind: "helper" },
    { name: "sparkle", version: "2.9.6", license: "MIT", url: "https://x/Sparkle-2.9.6.tar.xz", sha256: "c".repeat(64),
      archive: "tar.xz", extract: "", bundlePath: "tools/sparkle", exec: ["tools/sparkle/bin/generate_appcast"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "buildtool" },
  ],
};

function fakeApp(): string {
  const root = join(mkdtempSync(join(tmpdir(), "rt-bundle-")), "mattstack.app");
  mkdirSync(join(root, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(root, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(root, "Contents", "Helpers"), { recursive: true });
  writeFileSync(join(root, "Contents", "Info.plist"), "<plist/>");
  writeFileSync(join(root, "Contents", "MacOS", "rt"), "");
  writeFileSync(join(root, DEPS_LOCK_BUNDLE_PATH), JSON.stringify(LOCK));
  writeFileSync(join(root, "Contents", "Helpers", "fzf"), "");
  return root;
}

beforeEach(() => {
  __test__.resetBundleLayoutMemo();
});

describe("parseDepsLock", () => {
  test("accepts the schema and keeps tool order", () => {
    const lock = parseDepsLock(JSON.stringify(LOCK));
    expect(lock.tools.map((t) => t.name)).toEqual(["fzf", "fast-browser", "deck", "sparkle"]);
  });
  test("rejects duplicate names, bundled tools without url/sha256, and pending tools with a url", () => {
    const dup = { ...LOCK, tools: [LOCK.tools[0], LOCK.tools[0]] };
    expect(() => parseDepsLock(JSON.stringify(dup))).toThrow(/duplicate/);
    const noSha = { ...LOCK, tools: [{ ...LOCK.tools[0], sha256: "" }] };
    expect(() => parseDepsLock(JSON.stringify(noSha))).toThrow(/sha256/);
    const pendingUrl = { ...LOCK, tools: [{ ...LOCK.tools[2], url: "https://x" }] };
    expect(() => parseDepsLock(JSON.stringify(pendingUrl))).toThrow(/pending/);
  });
  test("rejects a bundlePath outside Contents/Helpers for helpers", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], bundlePath: "Contents/MacOS/fzf" }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/Contents\/Helpers/);
  });
  test("accepts a buildtool bundlePath outside Contents/Helpers (deps-dir-relative)", () => {
    const lock = parseDepsLock(JSON.stringify(LOCK));
    expect(lock.tools.find((t) => t.name === "sparkle")?.bundlePath).toBe("tools/sparkle");
  });
});

describe("bundleRootFromExec", () => {
  test("finds the .app root from Contents/MacOS/<bin>", () => {
    const root = fakeApp();
    // macOS resolves /var/folders through a /private symlink, so the
    // returned root only matches the realpath of the tmp dir, not its raw path.
    expect(bundleRootFromExec(join(root, "Contents", "MacOS", "rt"))).toBe(realpathSync(root));
  });
  test("null for a binary that is not inside a bundle", () => {
    expect(bundleRootFromExec("/usr/bin/true")).toBeNull();
  });
});

describe("bundledHelperPath / bundledExec", () => {
  test("resolve a bundled helper to its absolute path", () => {
    const root = fakeApp();
    expect(bundledHelperPath("fzf", root)).toBe(join(root, "Contents", "Helpers", "fzf"));
    expect(bundledExec("fzf", root)).toEqual([join(root, "Contents", "Helpers", "fzf")]);
  });
  test("null for a pending tool, an unknown tool, and a bundled tool whose file is missing", () => {
    const root = fakeApp();
    expect(bundledHelperPath("deck", root)).toBeNull();
    expect(bundledHelperPath("nope", root)).toBeNull();
    expect(bundledHelperPath("fast-browser", root)).toBeNull();
  });
  test("null when there is no bundle root", () => {
    expect(bundledHelperPath("fzf", null)).toBeNull();
    expect(readDepsLock("/nonexistent.app")).toBeNull();
  });
  test("refuse to resolve a buildtool kind rather than misjoin its deps-dir-relative path", () => {
    const root = fakeApp();
    expect(() => bundledExec("sparkle", root)).toThrow(/buildtool/);
    expect(() => bundledHelperPath("sparkle", root)).toThrow(/buildtool/);
  });
});

describe("memoization", () => {
  test("readDepsLock(root) is memoized per root — a later on-disk edit is not observed until reset", () => {
    const root = fakeApp();
    const first = readDepsLock(root);
    expect(first?.tools.map((t) => t.name)).toEqual(["fzf", "fast-browser", "deck", "sparkle"]);

    const changed = { ...LOCK, tools: [LOCK.tools[0]] };
    writeFileSync(join(root, DEPS_LOCK_BUNDLE_PATH), JSON.stringify(changed));
    expect(readDepsLock(root)?.tools.map((t) => t.name)).toEqual(["fzf", "fast-browser", "deck", "sparkle"]);

    __test__.resetBundleLayoutMemo();
    expect(readDepsLock(root)?.tools.map((t) => t.name)).toEqual(["fzf"]);
  });

  test("appBundleRoot() is memoized — a later exists() change is not observed until reset", () => {
    let flag = true;
    const exists = (_p: string) => flag;
    const first = appBundleRoot(exists);
    flag = false;
    expect(appBundleRoot(exists)).toBe(first);

    __test__.resetBundleLayoutMemo();
    expect(appBundleRoot(exists)).toBeNull();
  });
});
