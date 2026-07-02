import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import {
  runSdmCommand,
  getSdmSnapshot,
  invalidateSdmSnapshotCache,
  loginSdmWith,
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
