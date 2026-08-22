import { describe, test, expect, spyOn } from "bun:test";
import { servicesList, servicesRegister, servicesRestart, type ServicesDeps } from "../services.ts";
import { fakeProbes, fakeTray } from "../../lib/setup/__tests__/fakes.ts";

function baseDeps(overrides: Partial<ServicesDeps> = {}): ServicesDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    probes: fakeProbes({ home: "/home/x" }),
    print: (s: string) => lines.push(s),
    lines,
    ...overrides,
  };
}

/** exitUserError always calls the real process.exit, never deps.exit — spy on it to catch the code without actually killing the test process. */
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

  test("tray unreachable (status 0) exits 2 with app-not-running", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({}) }) });

    const code = await runExpectingProcessExit(() => servicesList(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("app-not-running");
  });
});

describe("servicesRegister", () => {
  test("no --plist given: registers the default plists (daemon only, deck not bundled)", async () => {
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
  });

  test("explicit --plist (repeatable) overrides the default set", async () => {
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
  });

  test("app reports ok:false -> exits 1, still prints the envelope", async () => {
    const deps = baseDeps({
      probes: fakeProbes({
        home: "/home/x",
        tray: fakeTray({ "POST /services/register": () => ({ status: 200, json: { ok: false, results: [{ status: "notFound" }] } }) }),
      }),
    });

    const code = await runExpectingProcessExit(() => servicesRegister(["--json"], {}, deps));

    expect(code).toBe(1);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.ok).toBe(false);
  });

  test("tray unreachable exits 2 with app-not-running", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({}) }) });

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

  test("missing label: usage exit 2", async () => {
    const deps = baseDeps();

    const code = await runExpectingProcessExit(() => servicesRestart(["--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("usage");
  });

  test("tray unreachable exits 2 with app-not-running", async () => {
    const deps = baseDeps({ probes: fakeProbes({ home: "/home/x", tray: fakeTray({}) }) });

    const code = await runExpectingProcessExit(() => servicesRestart(["com.mattstack.daemon", "--json"], {}, deps));

    expect(code).toBe(2);
    const body = JSON.parse(deps.lines[0]!);
    expect(body.error.code).toBe("app-not-running");
  });
});
