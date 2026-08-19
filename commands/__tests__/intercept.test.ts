import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERATED_MARKER } from "../../lib/endpoint/shim.ts";
import { resolveRealBinary } from "../intercept.ts";

const origPath = process.env.PATH;
const origReal = process.env.RT_INTERCEPT_REAL;

afterEach(() => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  if (origReal === undefined) delete process.env.RT_INTERCEPT_REAL;
  else process.env.RT_INTERCEPT_REAL = origReal;
});

function makeExecutable(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

describe("resolveRealBinary", () => {
  // Guards against recursing `rt intercept run` into itself: a shim file
  // COPIED (not symlinked) onto PATH ahead of the real binary would never
  // string-match `shimPath(command)` (that only ever points at
  // ~/.local/bin), so path comparison alone lets it through. The content
  // sniff for GENERATED_MARKER is what actually stops it.
  test("skips a marker-carrying shim copy that sits earlier on PATH than the real binary", () => {
    const shimDir = mkdtempSync(join(tmpdir(), "rt-resolve-shim-"));
    const realDir = mkdtempSync(join(tmpdir(), "rt-resolve-real-"));

    makeExecutable(shimDir, "fakecmd2", [
      "#!/bin/sh",
      GENERATED_MARKER,
      'exec rt intercept run fakecmd2 -- "$@"',
      "",
    ].join("\n"));
    const realPath = makeExecutable(realDir, "fakecmd2", "#!/bin/sh\necho real\n");

    process.env.PATH = `${shimDir}:${realDir}`;
    delete process.env.RT_INTERCEPT_REAL;

    expect(resolveRealBinary("fakecmd2")).toBe(realPath);
  });

  test("RT_INTERCEPT_REAL overrides the search entirely", () => {
    process.env.RT_INTERCEPT_REAL = "/some/override/path";
    expect(resolveRealBinary("anything")).toBe("/some/override/path");
  });

  test("returns null when no non-shim executable is found on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-resolve-empty-"));
    delete process.env.RT_INTERCEPT_REAL;
    process.env.PATH = dir;
    expect(resolveRealBinary("no-such-command")).toBeNull();
  });
});
