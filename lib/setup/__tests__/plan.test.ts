import { describe, test, expect } from "bun:test";
import { applyInstallSatisfiedFlip, composePlan } from "../plan.ts";
import { finalizePlan, row, type Group, type Row } from "../contract.ts";
import { UserActionableError } from "../errors.ts";
import { writeIntent, type SetupIntent } from "../intent.ts";
import type { SecretPresence } from "../validators/accounts.ts";
import { fakeProbes, fakeTray, ok } from "./fakes.ts";
import type { ExecScript } from "./fakes.ts";

function fakeSecrets(stored: Record<string, string> = {}): SecretPresence {
  return {
    async has(domain, key) {
      return stored[`${domain}.${key}`] ?? null;
    },
  };
}

/** Answers every probe the plan.ts validators make with a shape each row reads as "ready" — composePlan itself is under test here, not any one validator's edge cases. */
const readyExec: ExecScript = (argv) => {
  if (argv[0] === "sw_vers") return ok("15.6");
  if (argv[0] === "git" && argv[1] === "--version") return ok("git version 2.50.1");
  if (argv[0] === "herdr" && argv[1] === "integration") return ok("claude: current\n");
  if (argv[0] === "herdr") return ok("0.8.0");
  if (argv[0] === "claude" && argv[1] === "auth") return ok(JSON.stringify({ loggedIn: true }));
  if (argv[0] === "claude") return ok("1.2.3");
  if (argv[0] === "brew") return ok("Homebrew 4.0.0");
  if (argv[0] === "rt") return ok("rt v1.0.0");
  return ok();
};

const grantedTray = fakeTray({
  "GET /permissions": () => ({
    status: 200,
    json: { fda: { status: "granted" }, notifications: { status: "authorized" }, loginItems: { status: "enabled" } },
  }),
});

describe("composePlan", () => {
  test("no intent, no teams -> 4 groups in contract order, team.mode none, perm.fda ready", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: [] });

    expect(plan.contract).toBe(1);
    expect(plan.groups.map((g) => g.id)).toEqual(["mac", "accounts", "access", "tools"]);
    expect(plan.team).toEqual({ slug: "", name: "", mode: "none" });

    const mac = plan.groups.find((g) => g.id === "mac")!;
    const fda = mac.rows.find((r) => r.id === "perm.fda")!;
    expect(fda.status).toBe("ready");
  });

  test("tray unreachable, daemon tcc reports every repo readable -> perm.fda ready via the daemon fallback", async () => {
    const p = fakeProbes({
      exec: readyExec,
      // Default fakeProbes tray already answers status 0 (unreachable) when not overridden.
      daemon: async (cmd) => (cmd === "tcc:check" ? { ok: true, data: { blocked: [], accessible: ["a", "b"], totalRepos: 2 } } : null),
    });
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: [] });

    const mac = plan.groups.find((g) => g.id === "mac")!;
    const fda = mac.rows.find((r) => r.id === "perm.fda")!;
    expect(fda.status).toBe("ready");
    expect(fda.detail).toContain("via the daemon");
  });

  test("create intent -> team ref from the intent, forge derived from its remote, account.github row present", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const intent: SetupIntent = {
      v: 1,
      at: "2026-08-21T00:00:00.000Z",
      mode: "create",
      team: { slug: "acme", name: "Acme", remote: "https://github.com/o/r.git", others: false },
    };
    writeIntent(p, intent);

    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "plan", teams: [] });

    expect(plan.team).toEqual({ slug: "acme", name: "Acme", mode: "create" });
    const accounts = plan.groups.find((g) => g.id === "accounts")!;
    expect(accounts.rows.some((r) => r.id === "account.github")).toBe(true);
  });

  test("join intent -> forge derived from the invite pointer's own forge field, not re-parsed from its remote", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const intent: SetupIntent = {
      v: 1,
      at: "x",
      mode: "join",
      join: {
        id: "inv1",
        keyB64: "k",
        pointer: {
          v: 1,
          team: "acme",
          name: "Acme",
          // The remote alone would derive "example.com", not "github.com" — proves the pointer's own forge wins.
          remote: "https://example.com/acme/mattstack.git",
          owner: "owner1",
          forge: "github.com",
          createdAt: "x",
        },
      },
    };
    writeIntent(p, intent);

    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "plan", teams: [] });

    const accounts = plan.groups.find((g) => g.id === "accounts")!;
    expect(accounts.rows.some((r) => r.id === "account.github")).toBe(true);
  });

  test("--team naming an unknown team rejects with a user-actionable error instead of silently substituting a different plan", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });

    await expect(
      composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: ["acme"], teamOverride: "ghost" }),
    ).rejects.toThrow(UserActionableError);

    await expect(
      composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: ["acme"], teamOverride: "ghost" }),
    ).rejects.toThrow(/ghost/);
  });

  test("--team naming a discovered team wins over an unrelated intent's team", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const intent: SetupIntent = { v: 1, at: "x", mode: "restore", restore: { homeRepo: "r" } };
    writeIntent(p, intent);

    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: ["acme"], teamOverride: "acme" });
    expect(plan.team).toEqual({ slug: "acme", name: "acme", mode: "none" });
  });

  test("a group builder that throws degrades to one required error row with a re-check action, and canInstall stays false", async () => {
    const p = fakeProbes({
      exec: (argv) => {
        if (argv[0] === "sw_vers") throw new Error("boom");
        return ok();
      },
      tray: grantedTray,
    });

    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: [] });

    const mac = plan.groups.find((g) => g.id === "mac")!;
    expect(mac.rows).toHaveLength(1);
    const errorRow = mac.rows[0]!;
    expect(errorRow.status).toBe("error");
    expect(errorRow.detail).toContain("boom");
    expect(errorRow.required).toBe(true);
    expect(errorRow.action).toEqual({ type: "run", label: "Re-check", verb: ["setup", "status"] });

    // The group's unrun checks must still count against canInstall — a
    // degraded group is not the same thing as a group that came back clean.
    expect(plan.canInstall).toBe(false);
    expect(plan.requiredMissing).toContain(errorRow.id);
  });
});

describe("composePlan — install-satisfied flip", () => {
  test("plan mode: perm.login-items and tool.daemon read required:false with an optionalNote", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "plan", teams: [] });

    const mac = plan.groups.find((g) => g.id === "mac")!;
    const loginItems = mac.rows.find((r) => r.id === "perm.login-items")!;
    expect(loginItems.required).toBe(false);
    expect(loginItems.optionalNote).not.toBeNull();

    const tools = plan.groups.find((g) => g.id === "tools")!;
    const daemon = tools.rows.find((r) => r.id === "tool.daemon")!;
    expect(daemon.required).toBe(false);
    expect(daemon.optionalNote).not.toBeNull();
  });

  test("status mode: perm.login-items and tool.daemon read required:true with no optionalNote", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: [] });

    const mac = plan.groups.find((g) => g.id === "mac")!;
    const loginItems = mac.rows.find((r) => r.id === "perm.login-items")!;
    expect(loginItems.required).toBe(true);
    expect(loginItems.optionalNote).toBeNull();

    const tools = plan.groups.find((g) => g.id === "tools")!;
    const daemon = tools.rows.find((r) => r.id === "tool.daemon")!;
    expect(daemon.required).toBe(true);
    expect(daemon.optionalNote).toBeNull();
  });

  test("tool.plugins flips required across plan and status mode", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const planned = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "plan", teams: [] });
    const plannedRow = planned.groups.find((g) => g.id === "tools")!.rows.find((r) => r.id === "tool.plugins")!;
    expect(plannedRow.required).toBe(false);
    expect(plannedRow.optionalNote).not.toBeNull();

    const status = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teams: [] });
    const statusRow = status.groups.find((g) => g.id === "tools")!.rows.find((r) => r.id === "tool.plugins")!;
    expect(statusRow.required).toBe(true);
    expect(statusRow.optionalNote).toBeNull();
  });

  // The extension is loaded by hand in Chrome, so it must never reach
  // requiredMissing in either mode: status mode is what the verify Install
  // step runs, and a critical failure there would end every successful
  // install in failure.
  test("tool.fast-browser-extension never counts against canInstall, in either mode", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    for (const mode of ["plan", "status"] as const) {
      const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode, teams: [] });
      expect(plan.requiredMissing).not.toContain("tool.fast-browser-extension");
    }
  });
});

function statusPlan(rows: Row[]) {
  // Group requires a title as well as id and rows.
  const groups: Group[] = [{ id: "tools", title: "Tools", rows }];
  return finalizePlan({ slug: "acme", name: "Acme", mode: "none" }, applyInstallSatisfiedFlip(groups, "status"));
}

test("a skipped pack row never lands in requiredMissing, so it cannot block Install", () => {
  const plan = statusPlan([
    row({ id: "pack.remote", kind: "tool", title: "remote", why: "x", required: false, status: "skipped", detail: "version unknown; rt does not manage this source" }),
  ]);
  expect(plan.requiredMissing).not.toContain("pack.remote");
  expect(plan.canInstall).toBe(true);
});

test("on a machine with no claude, the skipped plugin rows do not block Install either", () => {
  const plan = statusPlan([
    row({ id: "tool.plugins", kind: "tool", title: "Claude plugins", why: "x", required: false, status: "skipped", detail: "claude not installed" }),
    row({ id: "pack.acme-skills", kind: "tool", title: "acme-skills", why: "x", required: false, status: "skipped", detail: "claude not installed" }),
  ]);
  expect(plan.requiredMissing).toEqual([]);
  expect(plan.canInstall).toBe(true);
});
