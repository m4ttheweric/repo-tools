import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  listConnectorFiles,
  runConnector,
  discoverConnections,
  invalidateCatalogCache,
  scaffoldConnector,
} from "../connectors.ts";

const dir = mkdtempSync(join(tmpdir(), "rt-sdm-connectors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => invalidateCatalogCache());

function writeConnector(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const GOOD_JSON = JSON.stringify({
  version: 1,
  connections: [
    { id: "one", label: "One", sdmResource: "example-one", tier: "staging" },
    { id: "two", label: "Two", sdmResource: "example-two", tier: "qa" },
  ],
});

describe("listConnectorFiles", () => {
  test("returns executables only, sorted", () => {
    writeConnector("bbb", `echo '${GOOD_JSON}'`);
    writeConnector("aaa", `echo '${GOOD_JSON}'`);
    writeFileSync(join(dir, "not-executable.txt"), "hi");
    const files = listConnectorFiles(dir);
    expect(files.map(f => f.split("/").pop())).toEqual(["aaa", "bbb"]);
  });

  test("missing dir yields empty list", () => {
    expect(listConnectorFiles(join(dir, "nope"))).toEqual([]);
  });
});

describe("runConnector", () => {
  test("parses and validates good output", async () => {
    const p = writeConnector("good", `echo '${GOOD_JSON}'`);
    const r = await runConnector(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.connections).toHaveLength(2);
  });

  test("garbage stdout is a validation error", async () => {
    const p = writeConnector("garbage", "echo not-json");
    const r = await runConnector(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON");
  });

  test("nonzero exit includes stderr", async () => {
    const p = writeConnector("boom", "echo broken >&2; exit 3");
    const r = await runConnector(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("broken");
  });

  test("hang is killed at the timeout", async () => {
    const p = writeConnector("hang", "sleep 5");
    const r = await runConnector(p, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("timed out");
  });
});

describe("discoverConnections", () => {
  test("merges, namespaces, isolates failures, and caches", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-disc-"));
    try {
      writeFileSync(join(freshDir, "good"), `#!/bin/bash\necho '${GOOD_JSON}'\n`);
      chmodSync(join(freshDir, "good"), 0o755);
      writeFileSync(join(freshDir, "bad"), "#!/bin/bash\nexit 1\n");
      chmodSync(join(freshDir, "bad"), 0o755);

      const r = await discoverConnections({ dir: freshDir });
      expect(r.connections.map(c => c.key)).toEqual(["good:one", "good:two"]);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]!.connector).toBe("bad");
      expect(r.fromCache).toBe(false);

      const cached = await discoverConnections({ dir: freshDir });
      expect(cached.fromCache).toBe(true);

      const refreshed = await discoverConnections({ dir: freshDir, refresh: true });
      expect(refreshed.fromCache).toBe(false);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("cache is scoped per directory", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "rt-sdm-disc-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "rt-sdm-disc-b-"));
    try {
      writeFileSync(join(dirA, "alpha"), `#!/bin/bash\necho '${GOOD_JSON}'\n`);
      chmodSync(join(dirA, "alpha"), 0o755);

      const otherJson = JSON.stringify({
        version: 1,
        connections: [{ id: "three", label: "Three", sdmResource: "example-three", tier: "staging" }],
      });
      writeFileSync(join(dirB, "beta"), `#!/bin/bash\necho '${otherJson}'\n`);
      chmodSync(join(dirB, "beta"), 0o755);

      const a = await discoverConnections({ dir: dirA });
      expect(a.connections.map(c => c.key)).toEqual(["alpha:one", "alpha:two"]);
      expect(a.fromCache).toBe(false);

      // Discovering dir B within the TTL must not return dir A's cached result.
      const b = await discoverConnections({ dir: dirB });
      expect(b.fromCache).toBe(false);
      expect(b.connections.map(c => c.key)).toEqual(["beta:three"]);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});

describe("scaffoldConnector", () => {
  test("writes an executable template and refuses overwrite", async () => {
    const p = scaffoldConnector("demo", dir);
    expect(existsSync(p)).toBe(true);
    const r = await runConnector(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.connections).toHaveLength(2);
    expect(() => scaffoldConnector("demo", dir)).toThrow(/exists/);
  });
});
