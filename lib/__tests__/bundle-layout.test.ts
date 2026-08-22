import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  bundleRootFromExec, bundledExec, bundledHelperPath, parseDepsLock, readDepsLock,
  appBundleRoot, DEPS_LOCK_BUNDLE_PATH, HELPERS_DIR, RT_BUNDLE_PATH, __test__,
} from "../bundle-layout.ts";

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    { name: "fzf", version: "0.74.3", license: "MIT", url: "https://x/fzf.tar.gz", sha256: "a".repeat(64),
      archive: "tar.gz", extract: "fzf", bundlePath: `${HELPERS_DIR}/fzf`, exec: [`${HELPERS_DIR}/fzf`],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "fast-browser", version: "0.1.0-alpha.11", license: "MIT", url: "https://x/fb.tgz", sha256: "b".repeat(64),
      archive: "npm", extract: "package", bundlePath: `${HELPERS_DIR}/fast-browser`,
      exec: [`${HELPERS_DIR}/node/bin/node`, `${HELPERS_DIR}/fast-browser/bin/fast-browser.mjs`],
      exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "deck", version: "", license: "MIT", url: "", sha256: "", archive: "raw", extract: "",
      bundlePath: `${HELPERS_DIR}/deck`, exec: [`${HELPERS_DIR}/deck`],
      exposeByDefault: true, entitlements: "jit", status: "pending", kind: "helper" },
    { name: "sparkle", version: "2.9.6", license: "MIT", url: "https://x/Sparkle-2.9.6.tar.xz", sha256: "c".repeat(64),
      archive: "tar.xz", extract: "", bundlePath: "tools/sparkle", exec: ["tools/sparkle/bin/generate_appcast"],
      exposeByDefault: false, entitlements: "none", status: "bundled", kind: "buildtool" },
  ],
};

function fakeApp(): string {
  const root = join(mkdtempSync(join(tmpdir(), "rt-bundle-")), "mattstack.app");
  mkdirSync(join(root, dirname(RT_BUNDLE_PATH)), { recursive: true });
  mkdirSync(join(root, dirname(DEPS_LOCK_BUNDLE_PATH)), { recursive: true });
  mkdirSync(join(root, HELPERS_DIR), { recursive: true });
  writeFileSync(join(root, "Contents", "Info.plist"), "<plist/>");
  writeFileSync(join(root, RT_BUNDLE_PATH), "");
  writeFileSync(join(root, DEPS_LOCK_BUNDLE_PATH), JSON.stringify(LOCK));
  writeFileSync(join(root, HELPERS_DIR, "fzf"), "");
  return root;
}

beforeEach(() => {
  __test__.resetBundleLayoutMemo();
});

// bun shares module state across test files in-process — without this, a
// memo populated here could leak into whichever file runs next.
afterAll(() => {
  __test__.resetBundleLayoutMemo();
});

describe("parseDepsLock", () => {
  test("accepts the schema and keeps tool order", () => {
    const lock = parseDepsLock(JSON.stringify(LOCK));
    expect(lock.tools.map((t) => t.name)).toEqual(["fzf", "fast-browser", "deck", "sparkle"]);
  });
  test("rejects an unsupported schema", () => {
    const bad = { ...LOCK, schema: 2 };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/schema/);
  });
  test("rejects a non-arm64 arch", () => {
    const bad = { ...LOCK, arch: "x86_64" };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/arch/);
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
  test("accepts a buildtool bundlePath/exec outside Contents/Helpers (deps-dir-relative)", () => {
    const lock = parseDepsLock(JSON.stringify(LOCK));
    const sparkle = lock.tools.find((t) => t.name === "sparkle");
    expect(sparkle?.bundlePath).toBe("tools/sparkle");
    expect(sparkle?.exec).toEqual(["tools/sparkle/bin/generate_appcast"]);
  });
  test("freezes the parsed lock, its tools array, and each tool row", () => {
    const lock = parseDepsLock(JSON.stringify(LOCK));
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock.tools)).toBe(true);
    expect(Object.isFrozen(lock.tools[0])).toBe(true);
    expect(() => lock.tools.sort(() => 0)).toThrow();
    expect(() => {
      (lock.tools[0] as { name: string }).name = "evil";
    }).toThrow();
  });
});

describe("parseDepsLock path safety", () => {
  test("rejects an absolute bundlePath", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], bundlePath: "/etc/passwd" }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/relative/);
  });
  test("rejects a bundlePath that walks up with ..", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], bundlePath: `${HELPERS_DIR}/../../../../tmp/evil` }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/\.\./);
  });
  test("rejects an absolute exec entry", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], exec: ["/bin/sh"] }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/relative/);
  });
  test("rejects an exec entry that walks up with ..", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], exec: [`${HELPERS_DIR}/../../../../bin/sh`] }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/\.\./);
  });
  test("rejects a helper exec entry outside Contents/Helpers even without traversal", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], exec: ["Contents/MacOS/rt"] }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/Contents\/Helpers/);
  });
});

describe("parseDepsLock malformed rows", () => {
  test("rejects a null tool entry with a deps.lock-voiced error, not a raw TypeError", () => {
    const bad = { ...LOCK, tools: [null] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/deps\.lock: tools\[0\] must be an object/);
  });
  test("rejects a numeric bundlePath with a deps.lock-voiced error, not a raw TypeError", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], bundlePath: 12345 }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/deps\.lock: tools\[0\]\.bundlePath must be a string/);
  });
  test("rejects a non-array, non-string exec entry with a deps.lock-voiced error", () => {
    const bad = { ...LOCK, tools: [{ ...LOCK.tools[0], exec: [null] }] };
    expect(() => parseDepsLock(JSON.stringify(bad))).toThrow(/deps\.lock: fzf exec\[0\] must be a string/);
  });
});

describe("bundleRootFromExec", () => {
  test("finds the .app root from Contents/MacOS/<bin>", () => {
    const root = fakeApp();
    // macOS resolves /var/folders through a /private symlink, so the
    // returned root only matches the realpath of the tmp dir, not its raw path.
    expect(bundleRootFromExec(join(root, RT_BUNDLE_PATH))).toBe(realpathSync(root));
  });
  test("null for a binary that is not inside a bundle", () => {
    expect(bundleRootFromExec("/usr/bin/true")).toBeNull();
  });
});

describe("bundledHelperPath / bundledExec", () => {
  test("resolve a bundled helper to its absolute path", () => {
    const root = fakeApp();
    expect(bundledHelperPath("fzf", root)).toBe(join(root, HELPERS_DIR, "fzf"));
    expect(bundledExec("fzf", root)).toEqual([join(root, HELPERS_DIR, "fzf")]);
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
  test("bundledExec is null when only some of a tool's exec entries exist on disk", () => {
    const root = fakeApp();
    mkdirSync(join(root, HELPERS_DIR, "node", "bin"), { recursive: true });
    writeFileSync(join(root, HELPERS_DIR, "node", "bin", "node"), "");
    // fast-browser/bin/fast-browser.mjs is deliberately never created.
    expect(bundledExec("fast-browser", root)).toBeNull();
  });
  test("refuse to resolve a buildtool kind rather than misjoin its deps-dir-relative path", () => {
    const root = fakeApp();
    expect(() => bundledExec("sparkle", root)).toThrow(/buildtool/);
    expect(() => bundledHelperPath("sparkle", root)).toThrow(/buildtool/);
  });
});

describe("memoization", () => {
  test("readDepsLock(root) re-reads automatically when the lock file's mtime/size changes", () => {
    const root = fakeApp();
    expect(readDepsLock(root)?.tools.map((t) => t.name)).toEqual(["fzf", "fast-browser", "deck", "sparkle"]);

    const changed = { ...LOCK, tools: [LOCK.tools[0]] };
    writeFileSync(join(root, DEPS_LOCK_BUNDLE_PATH), JSON.stringify(changed));
    expect(readDepsLock(root)?.tools.map((t) => t.name)).toEqual(["fzf"]);
  });

  test("appBundleRoot() with an INJECTED exists never memoizes — every call re-evaluates (R-T7-c)", () => {
    let installed = false;
    const exists = (_p: string) => installed;

    expect(appBundleRoot(exists)).toBeNull();

    installed = true;
    const resolved = appBundleRoot(exists);
    expect(resolved).not.toBeNull();

    // A non-default `exists` must bypass the memo on both read and write: a
    // later miss with the SAME injected function has to come back null
    // again, not keep serving the earlier hit.
    installed = false;
    expect(appBundleRoot(exists)).toBeNull();
  });

  test("appBundleRoot() with the DEFAULT exists (zero-arg call) still memoizes a hit", () => {
    // No injected `exists` here — this exercises the real fzf-picker hot
    // path (resolveFzf()'s own default), which is the memo's reason to
    // exist. Whatever the real machine resolves (often null in CI) must be
    // returned unchanged on a second zero-arg call.
    const first = appBundleRoot();
    const second = appBundleRoot();
    expect(second).toBe(first);
  });

  test("a default-exists memo never leaks into an injected-exists call", () => {
    // Populate the default-path memo first (may resolve null on a machine
    // with no real bundle installed — either way it must not leak into the
    // injected-exists call below).
    appBundleRoot();

    let installed = false;
    const exists = (_p: string) => installed;
    expect(appBundleRoot(exists)).toBeNull();

    installed = true;
    expect(appBundleRoot(exists)).not.toBeNull();
  });
});
