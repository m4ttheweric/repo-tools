import { describe, test, expect, spyOn } from "bun:test";
import { setupPlan, setupStatus, renderPlanHuman, type SetupDeps } from "../setup.ts";
import type { Plan } from "../../lib/setup/contract.ts";
import { writeIntent } from "../../lib/setup/intent.ts";
import type { SecretPresence } from "../../lib/setup/validators/accounts.ts";
import { fakeProbes, missing, ok } from "../../lib/setup/__tests__/fakes.ts";
import type { ExecScript } from "../../lib/setup/__tests__/fakes.ts";
import { green, red, reset } from "../../lib/ansi.ts";

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

  test("human mode appends a footer naming `rt setup <integration> connect` for each missing account", async () => {
    const lines: string[] = [];
    const p = fakeProbes({
      exec: (argv) => (argv[0] === "sw_vers" ? ok("15.6") : argv[0] === "gh" ? missing("gh") : ok()),
    });
    writeIntent(p, {
      v: 1,
      at: "2026-08-21T00:00:00.000Z",
      mode: "create",
      team: { slug: "acme", name: "Acme", remote: "https://github.com/o/r.git", others: false },
    });
    const deps: SetupDeps = { probes: p, secrets: fakeSecrets(), print: (s) => lines.push(s) };

    await setupStatus([], {}, deps);

    expect(lines).toContain("Missing accounts — connect with:");
    expect(lines).toContain("  - GitHub: rt setup github connect");
  });

  test("human mode omits the missing-accounts footer entirely when nothing is missing", async () => {
    const deps = captureDeps();
    await setupStatus([], {}, deps);

    expect(deps.lines.some((l) => l.includes("Missing accounts"))).toBe(false);
  });
});

// setupInteractive (the real TTY walk, not the old setupStatus alias) is
// covered in commands/__tests__/setup-apply.test.ts.

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
    expect(lines[1]).toBe(`  ${green}✓${reset} Full Disk Access  Granted`);
    expect(lines.at(-1)).toBe("Install: blocked by: perm.fda");
  });

  test("a missing row's glyph is colored red", () => {
    const plan: Plan = {
      contract: 1,
      at: "2026-08-21T00:00:00.000Z",
      team: { slug: "acme", name: "Acme", mode: "join" },
      groups: [
        {
          id: "accounts",
          title: "Accounts",
          rows: [
            { id: "account.linear", kind: "account", title: "Linear", why: "x", required: true, optionalNote: null, status: "missing", detail: "no account connected", action: null, recheck: "on-change" },
          ],
        },
      ],
      canInstall: false,
      requiredMissing: ["account.linear"],
    };

    expect(renderPlanHuman(plan)[1]).toBe(`  ${red}✗${reset} Linear  no account connected`);
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
