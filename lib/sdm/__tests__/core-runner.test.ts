import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import {
  runSdmCommand,
  runSdmLoginInteractive,
  getSdmSnapshot,
  invalidateSdmSnapshotCache,
  loginSdmWith,
  connectResourceWith,
  isTransientSdmConnectFailure,
  type RunSdm,
} from "../core.ts";

const FAKE_SDM = join(import.meta.dir, "fixtures", "fake-sdm.sh");

beforeEach(() => {
  process.env.RT_SDM_BIN = FAKE_SDM;
  invalidateSdmSnapshotCache();
});
afterEach(() => {
  delete process.env.RT_SDM_BIN;
  invalidateSdmSnapshotCache();
});

describe("runSdmCommand", () => {
  test("streams lines and reports success", async () => {
    const lines: string[] = [];
    const r = await runSdmCommand(["ok"], l => lines.push(l));
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(lines).toEqual(["line one", "line two"]);
  });

  test("captures stderr on failure", async () => {
    const r = await runSdmCommand(["fail"], () => {});
    expect(r.ok).toBe(false);
    expect(r.output).toContain("access denied");
  });

  test("kills and flags a hung process at the timeout", async () => {
    const start = Date.now();
    const r = await runSdmCommand(["sleep"], () => {}, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.spawnErrorCode).toBe("ETIMEDOUT");
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  test("missing binary maps to ENOENT", async () => {
    process.env.RT_SDM_BIN = "/nonexistent/sdm-not-here";
    const r = await runSdmCommand(["ok"], () => {});
    expect(r.ok).toBe(false);
    expect(r.spawnErrorCode).toBe("ENOENT");
  });
});

describe("getSdmSnapshot", () => {
  test("parses the status table and caches for subsequent calls", async () => {
    const snap = await getSdmSnapshot();
    expect(snap.health.status).toBe("ok");
    expect(snap.resources.get("example-shared-dev")!.address).toBe("127.0.0.1:15432");
    // Cached: break the binary; a cached read must not notice.
    process.env.RT_SDM_BIN = "/nonexistent/sdm-not-here";
    const cached = await getSdmSnapshot();
    expect(cached.health.status).toBe("ok");
    // force bypasses the cache.
    const fresh = await getSdmSnapshot(true);
    expect(fresh.health.status).toBe("not-installed");
  });
});

describe("loginSdmWith", () => {
  const mkRun = (result: { ok: boolean; output: string; timedOut?: boolean }): RunSdm =>
    (async (_args, _onLine, _opts) => ({ ...result, spawnErrorCode: null, exitCode: result.ok ? 0 : 1 })) as RunSdm;

  test("exit 0 is success", async () => {
    expect(await loginSdmWith(mkRun({ ok: true, output: "logged in" }), () => {})).toEqual({ ok: true });
  });

  test("timeout maps to SAML remediation text", async () => {
    const r = await loginSdmWith(mkRun({ ok: false, output: "", timedOut: true }), () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("SAML");
  });

  test("other failures surface trimmed output", async () => {
    const r = await loginSdmWith(mkRun({ ok: false, output: "  sso rejected  \n" }), () => {});
    expect(r).toEqual({ ok: false, error: "Login failed: sso rejected" });
  });

  test("passes login args and a generous timeout", async () => {
    let seenArgs: string[] = [];
    let seenTimeout = 0;
    const run: RunSdm = (async (args, _onLine, opts) => {
      seenArgs = args;
      seenTimeout = opts?.timeoutMs ?? 0;
      return { ok: true, output: "", spawnErrorCode: null, exitCode: 0 };
    }) as RunSdm;
    await loginSdmWith(run, () => {});
    expect(seenArgs).toEqual(["login"]);
    expect(seenTimeout).toBeGreaterThanOrEqual(120_000);
  });
});

describe("connectResourceWith", () => {
  // A run seam that replays a scripted list of outputs, one per attempt, and
  // records how many times it was called. Exhausted scripts keep returning the
  // last entry (mirrors a persistently-failing sdm connect).
  const mkRun = (outputs: Array<{ ok: boolean; output: string }>) => {
    let calls = 0;
    const run: RunSdm = (async (_args, onLine) => {
      const o = outputs[Math.min(calls, outputs.length - 1)]!;
      calls++;
      if (o.output) onLine(o.output);
      return { ok: o.ok, output: o.output, spawnErrorCode: null, exitCode: o.ok ? 0 : 1 };
    }) as RunSdm;
    return { run, calls: () => calls };
  };
  const noSleep = async () => {};

  test("isTransientSdmConnectFailure matches only the datasource-refresh race", () => {
    expect(isTransientSdmConnectFailure("error loading datasources")).toBe(true);
    expect(isTransientSdmConnectFailure("access denied")).toBe(false);
  });

  test("retries the transient 'error loading datasources' race, then succeeds", async () => {
    const { run, calls } = mkRun([
      { ok: false, output: "error loading datasources" },
      { ok: true, output: "connected" },
    ]);
    const r = await connectResourceWith(run, "acme-x-prod", () => {}, { waitsMs: [1, 2], sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(calls()).toBe(2);
  });

  test("gives up after exhausting retries on a persistent transient failure", async () => {
    const { run, calls } = mkRun([{ ok: false, output: "error loading datasources" }]);
    const r = await connectResourceWith(run, "acme-x-prod", () => {}, { waitsMs: [1, 2], sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("error loading datasources");
    expect(calls()).toBe(3); // initial attempt + two retries
  });

  test("does not retry a non-transient failure", async () => {
    const { run, calls } = mkRun([{ ok: false, output: "access denied" }]);
    const r = await connectResourceWith(run, "acme-x-prod", () => {}, { waitsMs: [1, 2], sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-access");
    expect(calls()).toBe(1);
  });

  test("treats 'already connected' output as success without retrying", async () => {
    const { run, calls } = mkRun([{ ok: false, output: "already connected" }]);
    const r = await connectResourceWith(run, "acme-x-prod", () => {}, { waitsMs: [1, 2], sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(calls()).toBe(1);
  });
});

describe("runSdmLoginInteractive", () => {
  test("missing binary maps to ENOENT with install message", async () => {
    process.env.RT_SDM_BIN = "/nonexistent/sdm-not-here";
    const r = await runSdmLoginInteractive(["login"], () => {});
    expect(r.ok).toBe(false);
    expect(r.spawnErrorCode).toBe("ENOENT");
    expect(r.output).toContain("strongdm.com");
  });

  test("kills a hung login at the timeout", async () => {
    const start = Date.now();
    const r = await runSdmLoginInteractive(["sleep"], () => {}, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(3_000);
  });
});
