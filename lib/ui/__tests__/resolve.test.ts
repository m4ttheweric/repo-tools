import { test, expect } from "bun:test";
import { resolveRtUi, RtUiMissingError, type ResolveProbes } from "../resolve.ts";

function probes(over: Partial<ResolveProbes>): ResolveProbes {
  return {
    env: {},
    exists: () => false,
    bundleRoot: () => null,
    sourceRoot: () => null,
    which: () => null,
    ...over,
  };
}

test("RT_UI_BIN wins over everything", () => {
  const p = probes({ env: { RT_UI_BIN: "/custom/rt-ui" }, bundleRoot: () => "/Applications/mattstack.app", sourceRoot: () => "/repo", exists: () => true });
  expect(resolveRtUi(p)).toBe("/custom/rt-ui");
});

test("a stale RT_UI_BIN names itself instead of falling through or spawning a ghost", () => {
  const p = probes({ env: { RT_UI_BIN: "/gone/rt-ui" }, sourceRoot: () => "/repo", exists: (path) => path === "/repo/ui/dist/rt-ui" });
  let err: unknown;
  try {
    resolveRtUi(p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RtUiMissingError);
  expect(String((err as Error).message)).toContain("/gone/rt-ui (RT_UI_BIN)");
});

test("a source checkout wins over an installed bundle (dev mode must never pin a stale helper)", () => {
  const p = probes({
    bundleRoot: () => "/Applications/mattstack-dev.app",
    sourceRoot: () => "/repo",
    exists: (path) => path === "/repo/ui/dist/rt-ui" || path === "/Applications/mattstack-dev.app/Contents/Helpers/rt-ui",
  });
  expect(resolveRtUi(p)).toBe("/repo/ui/dist/rt-ui");
});

test("a source checkout without a build falls through to the bundle, then PATH", () => {
  const bundled = "/Applications/mattstack.app/Contents/Helpers/rt-ui";
  const p = probes({ sourceRoot: () => "/repo", bundleRoot: () => "/Applications/mattstack.app", exists: (path) => path === bundled });
  expect(resolveRtUi(p)).toBe(bundled);
  const onPath = probes({ sourceRoot: () => "/repo", which: (b) => (b === "rt-ui" ? "/opt/homebrew/bin/rt-ui" : null) });
  expect(resolveRtUi(onPath)).toBe("/opt/homebrew/bin/rt-ui");
});

test("a compiled binary outside a bundle skips the source step", () => {
  const p = probes({ sourceRoot: () => null, which: () => "/usr/local/bin/rt-ui" });
  expect(resolveRtUi(p)).toBe("/usr/local/bin/rt-ui");
});

test("nothing found throws with every path tried and the build hint", () => {
  const p = probes({ sourceRoot: () => "/repo", bundleRoot: () => "/Applications/mattstack.app" });
  let err: unknown;
  try {
    resolveRtUi(p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(RtUiMissingError);
  const msg = String((err as Error).message);
  expect(msg).toContain("/repo/ui/dist/rt-ui");
  expect(msg).toContain("/Applications/mattstack.app/Contents/Helpers/rt-ui");
  expect(msg).toContain("bun run ui:build");
});
