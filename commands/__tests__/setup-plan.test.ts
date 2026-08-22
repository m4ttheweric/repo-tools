import { describe, test, expect, spyOn } from "bun:test";
import { setupPlan, setupStatus, setupInteractive, renderPlanHuman, type SetupDeps } from "../setup.ts";
import type { Plan } from "../../lib/setup/contract.ts";
import type { SecretPresence } from "../../lib/setup/validators/accounts.ts";
import { fakeProbes, ok } from "../../lib/setup/__tests__/fakes.ts";
import type { ExecScript } from "../../lib/setup/__tests__/fakes.ts";

/** setupPlan/setupStatus call process.exit(2) on a user-actionable error; the sentinel throw stops it from actually killing the test process, and the caller reads the exit code off the spy. */
async function runExpectingExit(fn: () => Promise<void>): Promise<number | undefined> {
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

function fakeSecrets(): SecretPresence {
  return { async has() { return null; } };
}

const readyExec: ExecScript = (argv) => {
  if (argv[0] === "sw_vers") return ok("15.6");
  return ok();
};

function captureDeps(): SetupDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    probes: fakeProbes({ exec: readyExec }),
    secrets: fakeSecrets(),
    print: (s) => lines.push(s),
    lines,
  };
}

describe("setupPlan", () => {
  test("--json prints exactly one line that parses to a Plan with contract:1", async () => {
    const deps = captureDeps();
    await setupPlan(["--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const plan = JSON.parse(deps.lines[0]!) as Plan;
    expect(plan.contract).toBe(1);
    expect(plan.groups.map((g) => g.id)).toEqual(["mac", "accounts", "access", "tools"]);
  });

  test("human mode prints the mac group's title", async () => {
    const deps = captureDeps();
    await setupPlan([], {}, deps);

    expect(deps.lines).toContain("Your Mac");
  });

  test("--team naming an unknown team --json: exit 2 with the contract's error envelope on stdout (deps.print)", async () => {
    const deps = captureDeps();
    const exitCode = await runExpectingExit(() => setupPlan(["--team", "ghost", "--json"], {}, deps));

    expect(exitCode).toBe(2);
    expect(deps.lines).toHaveLength(1);
    const payload = JSON.parse(deps.lines[0]!) as { contract: 1; error: { code: string; message: string } };
    expect(payload.contract).toBe(1);
    expect(payload.error.code).toBe("unknown-team");
    expect(payload.error.message).toContain("ghost");
  });

  test("--team naming an unknown team, human mode: exit 2 with a one-line rt-prefixed message", async () => {
    const deps = captureDeps();
    const exitCode = await runExpectingExit(() => setupPlan(["--team", "ghost"], {}, deps));

    expect(exitCode).toBe(2);
    expect(deps.lines).toHaveLength(1);
    expect(deps.lines[0]).toStartWith("rt setup: ");
    expect(deps.lines[0]).toContain("ghost");
  });
});

describe("setupStatus", () => {
  test("human mode prints the 'rt setup status' header", async () => {
    const deps = captureDeps();
    await setupStatus([], {}, deps);

    expect(deps.lines[0]).toBe("rt setup status");
  });

  test("--json prints exactly one line that parses to a Plan", async () => {
    const deps = captureDeps();
    await setupStatus(["--json"], {}, deps);

    expect(deps.lines).toHaveLength(1);
    const plan = JSON.parse(deps.lines[0]!) as Plan;
    expect(plan.contract).toBe(1);
  });
});

describe("setupInteractive", () => {
  test("is the same handler as setupStatus", () => {
    expect(setupInteractive).toBe(setupStatus);
  });
});

describe("renderPlanHuman", () => {
  test("group headers, one line per row with a status glyph, and an install footer", () => {
    const plan: Plan = {
      contract: 1,
      at: "2026-08-21T00:00:00.000Z",
      team: { slug: "acme", name: "Acme", mode: "join" },
      groups: [
        {
          id: "mac",
          title: "Your Mac",
          rows: [
            { id: "perm.fda", kind: "permission", title: "Full Disk Access", why: "x", required: true, optionalNote: null, status: "ready", detail: "Granted", action: null, recheck: "on-activate" },
          ],
        },
      ],
      canInstall: false,
      requiredMissing: ["perm.fda"],
    };

    const lines = renderPlanHuman(plan);
    expect(lines[0]).toBe("Your Mac");
    expect(lines[1]).toBe("  ✓ Full Disk Access  Granted");
    expect(lines.at(-1)).toBe("Install: blocked by: perm.fda");
  });

  test("canInstall:true renders 'Install: ready'", () => {
    const plan: Plan = {
      contract: 1,
      at: "2026-08-21T00:00:00.000Z",
      team: { slug: "acme", name: "Acme", mode: "join" },
      groups: [],
      canInstall: true,
      requiredMissing: [],
    };
    expect(renderPlanHuman(plan).at(-1)).toBe("Install: ready");
  });
});
