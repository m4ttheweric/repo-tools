import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { join } from "path";
import { createTestHome, rt } from "../harness.ts";

/**
 * Fake `sdm` CLI: enough of `status` and `access catalog` output for the
 * direct catalog scanner (lib/sdm/scan.ts) to discover two postgres
 * resources without a real StrongDM org. RT_SDM_BIN is spawned directly
 * (see lib/sdm/core.ts sdmBin()), so no PATH plumbing is needed.
 */
function writeFakeSdm(home: string): string {
  const binDir = join(home, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const fakeSdm = join(binDir, "sdm");
  writeFileSync(
    fakeSdm,
    `#!/bin/bash
if [ "$1" = "status" ]; then
  echo "DATASOURCE             STATUS       ADDRESS"
  exit 0
fi
if [ "$1" = "access" ] && [ "$2" = "catalog" ]; then
  echo "rs-abc123def0  assured-alpha-staging  cluster-x  postgres  env=staging"
  echo "rs-def456abc1  assured-beta-qa-prod  cluster-y  postgres  env=prod"
  exit 0
fi
exit 0
`,
  );
  chmodSync(fakeSdm, 0o755);
  return fakeSdm;
}

describe("sdm enrichment", () => {
  const { path: home, cleanup } = createTestHome();
  const fakeSdm = writeFakeSdm(home);
  const enrichmentPath = join(home, ".mattstack", "rt", "sdm", "enrichment.jsonc");
  afterAll(() => cleanup());

  test("no-arg audit prints the enrichment path and an enriched/raw count", async () => {
    const res = await rt(["sdm", "enrichment"], { home, env: { RT_SDM_BIN: fakeSdm } });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(enrichmentPath);
    expect(res.stdout).toContain("0/2 resources enriched");
  });

  test("init scaffolds the enrichment file with one key per scanned resource", async () => {
    const res = await rt(["sdm", "enrichment", "init"], { home, env: { RT_SDM_BIN: fakeSdm } });
    expect(res.exitCode).toBe(0);
    expect(existsSync(enrichmentPath)).toBe(true);
    const contents = readFileSync(enrichmentPath, "utf8");
    expect(contents).toContain('"assured-alpha-staging"');
    expect(contents).toContain('"assured-beta-qa-prod"');
  });
});
