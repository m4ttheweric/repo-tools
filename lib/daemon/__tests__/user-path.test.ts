import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { probeTools } from "../user-path.ts";

describe("probeTools", () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "rtpath-"));
    const node = join(binDir, "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n");
    chmodSync(node, 0o755);
  });

  test("reports a tool present on the path", () => {
    expect(probeTools(binDir, ["node"])).toEqual({ hasNode: true });
  });

  test("reports a tool absent from the path", () => {
    expect(probeTools(binDir, ["pnpm"])).toEqual({ hasPnpm: false });
  });

  test("probes every requested name across every path entry", () => {
    const probed = probeTools(`/nonexistent-rt-test:${binDir}`, ["node", "pnpm"]);

    expect(probed).toEqual({ hasNode: true, hasPnpm: false });
  });

  test("an empty path finds nothing", () => {
    expect(probeTools("", ["node"])).toEqual({ hasNode: false });
  });
});
