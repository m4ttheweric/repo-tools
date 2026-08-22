import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { composePlan } from "../plan.ts";
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
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status" });

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
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status" });

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

    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "plan" });

    expect(plan.team).toEqual({ slug: "acme", name: "Acme", mode: "create" });
    const accounts = plan.groups.find((g) => g.id === "accounts")!;
    expect(accounts.rows.some((r) => r.id === "account.github")).toBe(true);
  });

  test("teamOverride is ignored when it names no discovered team", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teamOverride: "not-a-real-team" });
    // No discovered teams -> override is ignored, falls back to teamRefFromIntent's empty ref.
    expect(plan.team).toEqual({ slug: "", name: "", mode: "none" });
  });

  describe("teamOverride naming a real discovered team", () => {
    const origHome = process.env.HOME;
    let home: string;

    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), "rt-plan-teams-"));
      process.env.HOME = home;
      mkdirSync(join(home, ".mattstack", "teams", "acme", "mattstack"), { recursive: true });
      writeFileSync(join(home, ".mattstack", "teams", "acme", "mattstack", "settings.team.jsonc"), "{}");
    });

    afterAll(() => {
      process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    });

    test("wins over an unrelated intent's team", async () => {
      const p = fakeProbes({ exec: readyExec, tray: grantedTray, home });
      const intent: SetupIntent = { v: 1, at: "x", mode: "restore", restore: { homeRepo: "r" } };
      writeIntent(p, intent);

      const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status", teamOverride: "acme" });
      expect(plan.team).toEqual({ slug: "acme", name: "acme", mode: "none" });
    });
  });

  test("a group builder that throws degrades to one error row, never a rejected plan", async () => {
    const p = fakeProbes({
      exec: (argv) => {
        if (argv[0] === "sw_vers") throw new Error("boom");
        return ok();
      },
      tray: grantedTray,
    });

    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status" });

    const mac = plan.groups.find((g) => g.id === "mac")!;
    expect(mac.rows).toHaveLength(1);
    expect(mac.rows[0]!.status).toBe("error");
    expect(mac.rows[0]!.detail).toContain("boom");
  });
});

describe("composePlan — install-satisfied flip", () => {
  test("plan mode: perm.login-items and tool.daemon read required:false with an optionalNote", async () => {
    const p = fakeProbes({ exec: readyExec, tray: grantedTray });
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "plan" });

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
    const plan = await composePlan({ p, secrets: fakeSecrets(), ci: false, mode: "status" });

    const mac = plan.groups.find((g) => g.id === "mac")!;
    const loginItems = mac.rows.find((r) => r.id === "perm.login-items")!;
    expect(loginItems.required).toBe(true);
    expect(loginItems.optionalNote).toBeNull();

    const tools = plan.groups.find((g) => g.id === "tools")!;
    const daemon = tools.rows.find((r) => r.id === "tool.daemon")!;
    expect(daemon.required).toBe(true);
    expect(daemon.optionalNote).toBeNull();
  });
});
