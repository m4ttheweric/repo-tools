import { describe, test, expect, spyOn } from "bun:test";
import { servicesList, servicesRegister, servicesRestart, type ServicesDeps } from "../services.ts";
import { fakeProbes, fakeTray } from "../../lib/setup/__tests__/fakes.ts";

function baseDeps(overrides: Partial<ServicesDeps> = {}): ServicesDeps & { lines: string[]; warnings: string[]; exitCodes: number[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  const exitCodes: number[] = [];
  return {
    probes: fakeProbes({ home: "/home/x" }),
    print: (s: string) => lines.push(s),
    warn: (s: string) => warnings.push(s),
    exit: (code: number): never => {
      exitCodes.push(code);
      throw new Error("exit sentinel");
    },
    lines,
    warnings,
    exitCodes,
    ...overrides,
  };
}

/** exitUserError always calls the real process.exit, never deps.exit (repo-wide convention) — spy on it to catch the code without actually killing the test process. Only the two ok:false paths route through deps.exit instead, so those tests read exitCodes directly. */
async function runExpectingProcessExit(fn: () => Promise<void>): Promise<number | undefined> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  try {
    await fn();
    return undefined;
  } catch {
    return exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
  } finally {
    exitSpy.mockRestore();
  }
}

describe("servicesList", () => {
  test("--json prints the /services envelope", async () => {
    const agents = [{ label: "com.mattstack.daemon", status: "enabled" }];
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({ "GET /services": () => ({ status: 200, json: { agents } }) }) }) });

    await servicesList(["--json"], {}, deps);

    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(typeof at).toBe("string");
    expect(body).toEqual({ contract: 1, agents });
  });

  test("human output lists label: status per agent", async () => {
    const agents = [{ label: "com.mattstack.daemon", status: "enabled" }];
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({ "GET /services": () => ({ status: 200, json: { agents } }) }) }) });

    await servicesList([], {}, deps);

    expect(deps.lines).toEqual(["com.mattstack.daemon: enabled"]);
  });

  test("a real 200 with an empty agents array is honestly empty, not an error", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({ "GET /services": () => ({ status: 200, json: { agents: [] } }) }) }) });

    await servicesList([], {}, deps);

    expect(deps.lines).toEqual(["rt services list: no registered agents"]);
  });

  test("tray unreachable (status 0) exits 2 with app-not-running", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x" }) });

    const code = await runExpectingProcessExit(() => servicesList(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("app-not-running");
  });

  test("app-reachable 500 is an honest error, not zero agents", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({ "GET /services": () => ({ status: 500, json: null }) }) }) });

    const code = await runExpectingProcessExit(() => servicesList(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("services-list-failed");
  });

  test("a 200 with a garbled (non-array agents) body is an honest error, not zero agents", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({ "GET /services": () => ({ status: 200, json: { oops: true } }) }) }) });

    const code = await runExpectingProcessExit(() => servicesList(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("services-list-failed");
  });
});

describe("servicesRegister", () => {
  test("no --plist given: registers the default plists (daemon only, deck not bundled) and warns once", async () => {
    const calls: unknown[] = [];
    const deps = baseDeps({
      probes: fakeProbes({
        home: "/home/x",
        tray: fakeTray({
          "POST /services/register": (body) => {
            calls.push(body);
            return { status: 200, json: { ok: true, results: [] } };
          },
        }),
      }),
    });

    await servicesRegister(["--json"], {}, deps);

    expect(calls).toEqual([{ plists: ["com.mattstack.daemon.plist"] }]);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.ok).toBe(true);
    expect(body.plists).toEqual(["com.mattstack.daemon.plist"]);
    expect(deps.warnings).toEqual(["deck not bundled yet — only the daemon is registered"]);
  });

  test("explicit --plist (repeatable, space form) overrides the default set and suppresses the warning", async () => {
    const calls: unknown[] = [];
    const deps = baseDeps({
      probes: fakeProbes({
        home: "/home/x",
        tray: fakeTray({
          "POST /services/register": (body) => {
            calls.push(body);
            return { status: 200, json: { ok: true } };
          },
        }),
      }),
    });

    await servicesRegister(["--plist", "com.mattstack.daemon.dev.plist", "--plist", "com.mattstack.deck.dev.plist", "--json"], {}, deps);

    expect(calls).toEqual([{ plists: ["com.mattstack.daemon.dev.plist", "com.mattstack.deck.dev.plist"] }]);
    expect(deps.warnings).toEqual([]);
  });

  test("explicit --plist=<name> (equals form) is honored, not silently ignored in favor of the default set", async () => {
    const calls: unknown[] = [];
    const deps = baseDeps({
      probes: fakeProbes({
        home: "/home/x",
        tray: fakeTray({
          "POST /services/register": (body) => {
            calls.push(body);
            return { status: 200, json: { ok: true } };
          },
        }),
      }),
    });

    await servicesRegister(["--plist=com.mattstack.deck.plist", "--json"], {}, deps);

    expect(calls).toEqual([{ plists: ["com.mattstack.deck.plist"] }]);
  });

  test("app reports ok:false -> exits 1 via the deps.exit seam, still prints the envelope", async () => {
    const deps = baseDeps({
      probes: fakeProbes({
        home: "/home/x",
        tray: fakeTray({ "POST /services/register": () => ({ status: 200, json: { ok: false, results: [{ status: "notFound" }] } }) }),
      }),
    });

    await expect(servicesRegister(["--json"], {}, deps)).rejects.toThrow("exit sentinel");

    expect(deps.exitCodes).toEqual([1]);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.ok).toBe(false);
  });

  test("tray unreachable exits 2 with app-not-running", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x" }) });

    const code = await runExpectingProcessExit(() => servicesRegister(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("app-not-running");
  });
});

describe("servicesRestart", () => {
  test("posts {label} and reports ok", async () => {
    const calls: unknown[] = [];
    const deps = baseDeps({
      probes: fakeProbes({
        home: "/home/x",
        tray: fakeTray({
          "POST /services/restart": (body) => {
            calls.push(body);
            return { status: 200, json: { ok: true } };
          },
        }),
      }),
    });

    await servicesRestart(["com.mattstack.daemon", "--json"], {}, deps);

    expect(calls).toEqual([{ label: "com.mattstack.daemon" }]);
    const body = JSON.parse(deps.lines[0]!);
    expect(body).toMatchObject({ ok: true, label: "com.mattstack.daemon" });
  });

  test("app reports ok:false -> exits 1 via the deps.exit seam", async () => {
    const deps = baseDeps({
      probes: fakeProbes({
        home: "/home/x",
        tray: fakeTray({ "POST /services/restart": () => ({ status: 200, json: { ok: false } }) }),
      }),
    });

    await expect(servicesRestart(["com.mattstack.daemon", "--json"], {}, deps)).rejects.toThrow("exit sentinel");

    expect(deps.exitCodes).toEqual([1]);
  });

  test("missing label: usage exit 2", async () => {
    const deps = baseDeps();

    const code = await runExpectingProcessExit(() => servicesRestart(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("usage");
  });

  test("tray unreachable exits 2 with app-not-running", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x" }) });

    const code = await runExpectingProcessExit(() => servicesRestart(["com.mattstack.daemon", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("app-not-running");
  });
});
