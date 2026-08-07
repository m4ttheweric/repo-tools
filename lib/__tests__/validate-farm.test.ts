import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createControllerClient,
  ensureEndpoints,
  manifestHash,
  normalizeOrigin,
  resolveRepoId,
  summarizeRun,
  verdictExitCode,
  type Run,
} from "../validate-farm.ts";

// ─── repoId resolution (fixture overlay dir, never the real ~/.rt) ───────────

describe("resolveRepoId", () => {
  let overlayRoot: string;

  beforeEach(() => {
    overlayRoot = mkdtempSync(join(tmpdir(), "rt-overlay-"));
    const dir = join(overlayRoot, "acme-dev");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "repo.jsonc"),
      `{\n  // the mirror origin\n  "origin": "https://gitlab.com/acme/acme-dev.git",\n  "defaultBranch": "master",\n}\n`,
    );
    // Overlay dir with no repo.jsonc must be skipped, not crash the scan.
    mkdirSync(join(overlayRoot, "no-mapping"));
  });

  afterEach(() => {
    try { rmSync(overlayRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  test("matches the overlay dir by origin URL", () => {
    expect(resolveRepoId("https://gitlab.com/acme/acme-dev.git", overlayRoot)).toBe("acme-dev");
  });

  test("matches across ssh/https spellings of the same origin", () => {
    expect(resolveRepoId("git@gitlab.com:acme/acme-dev.git", overlayRoot)).toBe("acme-dev");
    expect(resolveRepoId("ssh://git@gitlab.com/acme/acme-dev", overlayRoot)).toBe("acme-dev");
  });

  test("returns null for an origin no overlay claims", () => {
    expect(resolveRepoId("git@github.com:someone/else.git", overlayRoot)).toBeNull();
  });

  test("returns null when the overlay root does not exist", () => {
    expect(resolveRepoId("git@gitlab.com:a/b.git", join(overlayRoot, "missing"))).toBeNull();
  });

  test("skips a malformed repo.jsonc instead of throwing", () => {
    const bad = join(overlayRoot, "broken");
    mkdirSync(bad);
    writeFileSync(join(bad, "repo.jsonc"), "{ not json");
    expect(resolveRepoId("https://gitlab.com/acme/acme-dev.git", overlayRoot)).toBe("acme-dev");
  });
});

describe("normalizeOrigin", () => {
  test("all spellings of one repo normalize identically", () => {
    const want = "gitlab.com/acme/acme-dev";
    expect(normalizeOrigin("git@gitlab.com:acme/acme-dev.git")).toBe(want);
    expect(normalizeOrigin("https://gitlab.com/acme/acme-dev")).toBe(want);
    expect(normalizeOrigin("ssh://git@gitlab.com/acme/acme-dev.git")).toBe(want);
  });
});

// ─── manifest hashing ────────────────────────────────────────────────────────

describe("manifestHash", () => {
  test("stable under key reordering", () => {
    const a = { image: "img", taskGroups: [{ name: "lint", run: "x" }], env: { A: "1", B: "2" } };
    const b = { env: { B: "2", A: "1" }, taskGroups: [{ run: "x", name: "lint" }], image: "img" };
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  test("changes when content changes", () => {
    const a = { image: "img", taskGroups: [{ name: "lint", run: "x" }] };
    const b = { image: "img", taskGroups: [{ name: "lint", run: "y" }] };
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });

  test("array order is content, not noise", () => {
    const a = { taskGroups: [{ name: "a" }, { name: "b" }] };
    const b = { taskGroups: [{ name: "b" }, { name: "a" }] };
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
});

// ─── controller client (injected fetch) ──────────────────────────────────────

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1", repoId: "acme-dev", tree: "t1", manifestHash: "m1",
    status: "done", groups: [], createdAt: "2026-08-07T00:00:00Z",
    ...over,
  };
}

describe("createControllerClient", () => {
  test("submit POSTs the request and returns runId + cached", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ runId: "r1", cached: false }), { status: 200 });
    }) as typeof fetch;

    const client = createControllerClient("http://ctrl:8080", fetchFn);
    const req = {
      repoId: "acme-dev", tree: "t1", manifestHash: "m1",
      manifest: { image: "img", taskGroups: [] }, changedFiles: ["a.ts"], mergeBase: "mb",
    };
    const res = await client.submit(req);

    expect(res).toEqual({ runId: "r1", cached: false });
    expect(calls[0]!.url).toBe("http://ctrl:8080/validate");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(req);
  });

  test("getRun returns null on 404 and the Run on 200", async () => {
    const fetchFn = (async (url: any) => {
      if (String(url).endsWith("/runs/missing")) return new Response("", { status: 404 });
      return new Response(JSON.stringify(run()), { status: 200 });
    }) as typeof fetch;

    const client = createControllerClient("http://ctrl:8080", fetchFn);
    expect(await client.getRun("missing")).toBeNull();
    expect((await client.getRun("r1"))?.id).toBe("r1");
  });

  test("getGroupLog returns the log text", async () => {
    const fetchFn = (async (url: any) => {
      expect(String(url)).toBe("http://ctrl:8080/runs/r1/logs/lint");
      return new Response("boom", { status: 200 });
    }) as typeof fetch;
    const client = createControllerClient("http://ctrl:8080", fetchFn);
    expect(await client.getGroupLog("r1", "lint")).toBe("boom");
  });
});

// ─── verdict mapping ─────────────────────────────────────────────────────────

describe("verdictExitCode", () => {
  test("all pass → 0 (farm-green)", () => {
    expect(verdictExitCode(run({ groups: [{ name: "lint", status: "pass" }] }))).toBe(0);
  });

  test("inherited-only failures stay farm-green → 0", () => {
    expect(verdictExitCode(run({ groups: [
      { name: "lint", status: "pass" },
      { name: "tests", status: "inherited" },
    ] }))).toBe(0);
  });

  test("skipped groups do not affect the verdict", () => {
    expect(verdictExitCode(run({ groups: [{ name: "cvi", status: "skipped" }] }))).toBe(0);
  });

  test("any fail → 1", () => {
    expect(verdictExitCode(run({ groups: [
      { name: "lint", status: "pass" },
      { name: "tests", status: "fail" },
    ] }))).toBe(1);
  });

  test("run infra or any infra group → 2", () => {
    expect(verdictExitCode(run({ status: "infra" }))).toBe(2);
    expect(verdictExitCode(run({ groups: [{ name: "tests", status: "infra" }] }))).toBe(2);
  });
});

describe("summarizeRun", () => {
  test("speaks farm language, never CI-green", () => {
    const green = summarizeRun(run({ groups: [{ name: "lint", status: "pass" }] }));
    expect(green).toContain("farm-green");
    expect(green).not.toContain("CI");
  });

  test("labels inherited-only failures", () => {
    const s = summarizeRun(run({ groups: [
      { name: "lint", status: "pass" },
      { name: "tests", status: "inherited" },
    ] }));
    expect(s).toContain("inherited");
    expect(s).toContain("farm-green");
  });

  test("infra is not a code verdict", () => {
    expect(summarizeRun(run({ status: "infra" }))).toContain("not a code verdict");
  });
});

// ─── endpoint readiness ──────────────────────────────────────────────────────

describe("ensureEndpoints", () => {
  const noDelay = () => Promise.resolve();

  test("does not spawn when the controller already answers", async () => {
    let spawned = false;
    const handle = await ensureEndpoints({
      probe: async () => true,
      spawnForwards: () => { spawned = true; return { stop: () => {} }; },
      delayMs: noDelay,
    });
    expect(handle.status).toBe("already-up");
    expect(spawned).toBe(false);
  });

  test("spawns forwards and reports ready once the probe flips", async () => {
    let probes = 0;
    let spawned = false;
    const handle = await ensureEndpoints({
      probe: async () => ++probes > 2,
      spawnForwards: () => { spawned = true; return { stop: () => {} }; },
      delayMs: noDelay,
    });
    expect(handle.status).toBe("forwarded");
    expect(spawned).toBe(true);
  });

  test("stops the forwards and reports unreachable when the probe never flips", async () => {
    let stopped = false;
    const handle = await ensureEndpoints({
      probe: async () => false,
      spawnForwards: () => ({ stop: () => { stopped = true; } }),
      delayMs: noDelay,
    });
    expect(handle.status).toBe("unreachable");
    expect(stopped).toBe(true);
  });
});
