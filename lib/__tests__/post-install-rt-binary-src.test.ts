/**
 * commands/post-install.ts — resolveRtBinarySrc() (MAT-383 §2/§3).
 *
 * Pure decision logic for where installRtBinaryStep() links `~/.local/bin/rt`
 * from: it must point INTO the bundle post-install just copied, never at the
 * transient extracted-tarball binary (process.execPath) — that dir is gone
 * once install finishes, which would leave a dangling link. Tested in
 * isolation via an injectable `exists`, since the real decision also depends
 * on `process.execPath`'s sibling — a path this suite must not touch for
 * real (it's the test runner's own binary).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveRtBinarySrc } from "../../commands/post-install.ts";
import { RT_BUNDLE_PATH } from "../bundle-layout.ts";

const BUNDLE_DEST = "/fake/Applications/mattstack.app";
const EXEC_PATH = "/fake/extracted-tarball/rt";

describe("resolveRtBinarySrc", () => {
  test("prefers the rt inside the installed bundle when it exists", () => {
    const bundleBinary = join(BUNDLE_DEST, RT_BUNDLE_PATH);
    const exists = (p: string) => p === bundleBinary;
    expect(resolveRtBinarySrc(BUNDLE_DEST, EXEC_PATH, exists)).toEqual({
      src: bundleBinary,
      fallbackWarning: false,
    });
  });

  test("falls back to execPath, flagged, when the bundle has no Contents/MacOS/rt but we're running from an extracted release", () => {
    const execSiblingBundle = join(EXEC_PATH, "..", "mattstack.app");
    const exists = (p: string) => p === execSiblingBundle;
    expect(resolveRtBinarySrc(BUNDLE_DEST, EXEC_PATH, exists)).toEqual({
      src: EXEC_PATH,
      fallbackWarning: true,
    });
  });

  test("returns null when neither the bundle nor an extracted release is present", () => {
    expect(resolveRtBinarySrc(BUNDLE_DEST, EXEC_PATH, () => false)).toBeNull();
  });

  test("prefers the installed bundle even when an extracted release is also present", () => {
    const bundleBinary = join(BUNDLE_DEST, RT_BUNDLE_PATH);
    const execSiblingBundle = join(EXEC_PATH, "..", "mattstack.app");
    const exists = (p: string) => p === bundleBinary || p === execSiblingBundle;
    expect(resolveRtBinarySrc(BUNDLE_DEST, EXEC_PATH, exists)).toEqual({
      src: bundleBinary,
      fallbackWarning: false,
    });
  });
});
