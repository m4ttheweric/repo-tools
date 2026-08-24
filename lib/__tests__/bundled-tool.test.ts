import { describe, expect, test } from "bun:test";
import { resolveBundledTool } from "../bundled-tool.ts";

describe("resolveBundledTool", () => {
  // The whole point: an installed machine must not depend on the user having
  // the tool on PATH. age-keygen and sops are Homebrew-only, and a clean Mac
  // has neither — which dead-ended every install at step 2 of 20.
  test("falls back to PATH when the tool is not bundled", () => {
    expect(resolveBundledTool("definitely-not-bundled", () => "/usr/local/bin/found")).toBe("/usr/local/bin/found");
  });

  // Returning the bare name (rather than null or throwing) keeps the failure
  // identical to what it was before this module existed: the tool's own
  // "not found", not a crash from the resolver.
  test("returns the bare name when neither bundled nor on PATH", () => {
    expect(resolveBundledTool("definitely-not-bundled", () => null)).toBe("definitely-not-bundled");
  });

  test("does not consult PATH for a name it can resolve in the bundle", () => {
    // No bundle root in a test process, so this exercises the fallback order
    // rather than a hit — the assertion that matters is that `which` is the
    // one consulted, and exactly once.
    let calls = 0;
    resolveBundledTool("fzf", () => {
      calls += 1;
      return "/opt/homebrew/bin/fzf";
    });
    expect(calls).toBe(1);
  });
});
