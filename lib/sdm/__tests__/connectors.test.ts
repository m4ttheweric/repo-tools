import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  listConnectorFiles,
  runConnector,
  runConnectorResolve,
  discoverConnections,
  resolveConnection,
  invalidateCatalogCache,
  scaffoldConnector,
  catalogCachePath,
} from "../connectors.ts";

const dir = mkdtempSync(join(tmpdir(), "rt-sdm-connectors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Every test gets an isolated HOME so catalogCachePath() (~/.rt/sdm/catalog-cache.json)
// never touches the real developer machine and no test's persisted cache can
// leak into another test's.
const origHome = process.env.HOME;
let testHome: string;
beforeEach(() => {
  invalidateCatalogCache();
  testHome = mkdtempSync(join(tmpdir(), "rt-sdm-home-"));
  process.env.HOME = testHome;
});
afterEach(() => {
  process.env.HOME = origHome;
  rmSync(testHome, { recursive: true, force: true });
});

function writeConnector(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const FAKE_CONNECTOR = join(import.meta.dir, "fixtures", "fake-connector.ts");
const BROKEN_CONNECTOR = join(import.meta.dir, "fixtures", "fake-connector-broken.ts");

function installFakeConnector(name: string, targetDir = dir): string {
  const p = join(targetDir, name);
  writeFileSync(p, readFileSync(FAKE_CONNECTOR));
  chmodSync(p, 0o755);
  return p;
}

function installBrokenConnector(name: string, targetDir = dir): string {
  const p = join(targetDir, name);
  writeFileSync(p, readFileSync(BROKEN_CONNECTOR));
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

  test("succeeds when process.env.PATH lacks bun (daemon's minimal launchd PATH)", async () => {
    const p = join(dir, "bun-connector");
    writeFileSync(p, `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(GOOD_JSON)});\n`);
    chmodSync(p, 0o755);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      const r = await runConnector(p);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.output.connections).toHaveLength(2);
    } finally {
      process.env.PATH = savedPath;
    }
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

describe("discoverConnections persistent cache", () => {
  test("first discover writes catalog-cache.json", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-persist-"));
    try {
      writeFileSync(join(freshDir, "good"), `#!/bin/bash\necho '${GOOD_JSON}'\n`);
      chmodSync(join(freshDir, "good"), 0o755);

      const r = await discoverConnections({ dir: freshDir });
      expect(r.connections.map(c => c.key)).toEqual(["good:one", "good:two"]);

      const raw = JSON.parse(readFileSync(catalogCachePath(), "utf8"));
      expect(typeof raw.builtAt).toBe("number");
      expect(raw.result.connections.map((c: { key: string }) => c.key)).toEqual(["good:one", "good:two"]);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("a cold in-memory cache still returns the persisted connections within TTL", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-persist-"));
    try {
      writeFileSync(join(freshDir, "good"), `#!/bin/bash\necho '${GOOD_JSON}'\n`);
      chmodSync(join(freshDir, "good"), 0o755);

      const first = await discoverConnections({ dir: freshDir });
      expect(first.fromCache).toBe(false);

      // Empty the connectors dir and drop the in-memory cache, simulating a
      // fresh CLI process starting cold while sdm/gitlab is briefly unreachable.
      rmSync(join(freshDir, "good"));
      invalidateCatalogCache();

      const second = await discoverConnections({ dir: freshDir });
      expect(second.fromCache).toBe(true);
      expect(second.connections.map(c => c.key)).toEqual(["good:one", "good:two"]);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("refresh bypasses the persisted cache and rewrites it", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-persist-"));
    try {
      writeFileSync(join(freshDir, "good"), `#!/bin/bash\necho '${GOOD_JSON}'\n`);
      chmodSync(join(freshDir, "good"), 0o755);
      await discoverConnections({ dir: freshDir });

      const otherJson = JSON.stringify({
        version: 1,
        connections: [{ id: "three", label: "Three", sdmResource: "example-three", tier: "staging" }],
      });
      writeFileSync(join(freshDir, "good"), `#!/bin/bash\necho '${otherJson}'\n`);

      const refreshed = await discoverConnections({ dir: freshDir, refresh: true });
      expect(refreshed.fromCache).toBe(false);
      expect(refreshed.connections.map(c => c.key)).toEqual(["good:three"]);

      const raw = JSON.parse(readFileSync(catalogCachePath(), "utf8"));
      expect(raw.result.connections.map((c: { key: string }) => c.key)).toEqual(["good:three"]);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("an empty/all-error discover does not overwrite an existing good cache file", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-persist-"));
    try {
      writeFileSync(join(freshDir, "good"), `#!/bin/bash\necho '${GOOD_JSON}'\n`);
      chmodSync(join(freshDir, "good"), 0o755);
      await discoverConnections({ dir: freshDir });
      const before = readFileSync(catalogCachePath(), "utf8");

      rmSync(join(freshDir, "good"));
      writeFileSync(join(freshDir, "bad"), "#!/bin/bash\nexit 1\n");
      chmodSync(join(freshDir, "bad"), 0o755);

      // refresh:true forces a real run against the now-all-error dir instead
      // of serving the still-fresh in-memory/persisted good result.
      const r = await discoverConnections({ dir: freshDir, refresh: true });
      expect(r.connections).toHaveLength(0);
      expect(r.errors).toHaveLength(1);

      const after = readFileSync(catalogCachePath(), "utf8");
      expect(after).toEqual(before);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("a corrupt cache file is ignored and falls through to running connectors", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-persist-"));
    try {
      writeFileSync(join(freshDir, "good"), `#!/bin/bash\necho '${GOOD_JSON}'\n`);
      chmodSync(join(freshDir, "good"), 0o755);

      mkdirSync(dirname(catalogCachePath()), { recursive: true });
      writeFileSync(catalogCachePath(), "not json");

      const r = await discoverConnections({ dir: freshDir });
      expect(r.fromCache).toBe(false);
      expect(r.connections.map(c => c.key)).toEqual(["good:one", "good:two"]);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe("runConnectorResolve", () => {
  test("resolves a url to a connection", async () => {
    const p = installFakeConnector("resolver-good");
    const r = await runConnectorResolve(p, "https://example.com/resolve-me/thing");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.connections).toHaveLength(1);
      expect(r.output.connections[0]!.id).toBe("res1");
    }
  });

  test("resolves a url to an unresolved gap", async () => {
    const p = installFakeConnector("resolver-ambiguous");
    const r = await runConnectorResolve(p, "https://example.com/ambiguous/thing");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.connections).toHaveLength(0);
      expect(r.output.unresolved).toHaveLength(1);
      expect(r.output.unresolved![0]!.source).toBe("ambiguous");
    }
  });

  test("no match yields empty output", async () => {
    const p = installFakeConnector("resolver-none");
    const r = await runConnectorResolve(p, "https://example.com/nope");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.connections).toHaveLength(0);
      expect(r.output.unresolved ?? []).toHaveLength(0);
    }
  });
});

describe("discoverConnections unresolved passthrough", () => {
  test("stamps connector and key onto unresolved gaps", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-disc-unresolved-"));
    try {
      installFakeConnector("fake", freshDir);
      const r = await discoverConnections({ dir: freshDir });
      expect(r.unresolved).toHaveLength(1);
      expect(r.unresolved![0]).toMatchObject({ id: "gap1", connector: "fake", key: "fake:gap1" });
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe("discoverConnections allResources passthrough", () => {
  test("surfaces a connector's allResources stamped with its name", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-disc-allresources-"));
    try {
      installFakeConnector("fake", freshDir);
      const r = await discoverConnections({ dir: freshDir });
      expect(r.allResources).toEqual([
        { name: "example-conn1", connector: "fake" },
        { name: "example-a", connector: "fake" },
        { name: "example-b", connector: "fake" },
        { name: "example-orphan", connector: "fake" },
      ]);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

describe("resolveConnection", () => {
  test("returns the resolved connection from the matching connector", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-resolve-"));
    try {
      installFakeConnector("only", freshDir);
      const r = await resolveConnection("https://example.com/resolve-me/thing", { dir: freshDir });
      expect(r).not.toBeNull();
      expect(r?.connector).toBe("only");
      expect(r?.connection?.id).toBe("res1");
      expect(r?.connection?.key).toBe("only:res1");
      expect(r?.unresolved).toBeUndefined();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("returns an unresolved gap when a connector recognizes but cannot resolve the url", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-resolve-amb-"));
    try {
      installFakeConnector("only", freshDir);
      const r = await resolveConnection("https://example.com/ambiguous/thing", { dir: freshDir });
      expect(r).not.toBeNull();
      expect(r?.connection).toBeUndefined();
      expect(r?.unresolved?.key).toBe("only:res-amb");
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("returns null when no connector recognizes the url", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-resolve-none-"));
    try {
      installFakeConnector("only", freshDir);
      const r = await resolveConnection("https://example.com/nope", { dir: freshDir });
      expect(r).toBeNull();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("tries connectors in order and stops at the first that yields a result", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-resolve-order-"));
    try {
      installFakeConnector("a-first", freshDir);
      installFakeConnector("b-second", freshDir);
      const r = await resolveConnection("https://example.com/resolve-me/thing", { dir: freshDir });
      expect(r?.connector).toBe("a-first");
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("collects a run error and returns it when no connector resolves the url", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-resolve-err-"));
    try {
      installBrokenConnector("broken", freshDir);
      const r = await resolveConnection("https://example.com/anything", { dir: freshDir });
      expect(r).not.toBeNull();
      expect(r?.connection).toBeUndefined();
      expect(r?.unresolved).toBeUndefined();
      expect(r?.errors).toHaveLength(1);
      expect(r?.errors?.[0]!.connector).toBe("broken");
      expect(r?.errors?.[0]!.error).toContain("simulated resolve failure");
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("keeps an earlier connector's run error alongside a later connector's match", async () => {
    const freshDir = mkdtempSync(join(tmpdir(), "rt-sdm-resolve-err-order-"));
    try {
      installBrokenConnector("a-broken", freshDir);
      installFakeConnector("b-good", freshDir);
      const r = await resolveConnection("https://example.com/resolve-me/thing", { dir: freshDir });
      expect(r).not.toBeNull();
      expect(r?.connector).toBe("b-good");
      expect(r?.connection?.id).toBe("res1");
      expect(r?.errors).toHaveLength(1);
      expect(r?.errors?.[0]!.connector).toBe("a-broken");
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
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
