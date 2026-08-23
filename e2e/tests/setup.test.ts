/**
 * `rt setup`/`rt deps`/`rt team join`/`rt uninstall`/`rt update` — the setup
 * verbs (MAT-383) driven against the COMPILED `dist/rt` binary, one
 * hermetic HOME, no live tray app or daemon.
 *
 * `RT_APP_SOCKET=/nonexistent.sock` is the load-bearing env var: it makes
 * every tray-socket probe (`fetchPermissions`, `rt update`'s check, apply's
 * `need()` reachability probe) fail the SAME deterministic way regardless of
 * whether this machine happens to have mattstack.app installed and running —
 * without it, `perm.fda` and `rt update`'s outcome would depend on whoever's
 * laptop the suite runs on.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestHome, rt } from "../harness.ts";

describe("rt setup verbs (e2e, no live app/daemon)", () => {
  let home: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
  });

  afterAll(() => cleanup());

  function run(args: string[]) {
    return rt(args, { home, env: { RT_APP_SOCKET: "/nonexistent.sock" } });
  }

  test("setup plan --json: one envelope line, contract-ordered groups, perm.fda reports no-app", async () => {
    const res = await run(["setup", "plan", "--json"]);
    expect(res.exitCode).toBe(0);

    const lines = res.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);

    const plan = JSON.parse(lines[0]!);
    expect(plan.contract).toBe(1);
    // Fixed group order from lib/setup/plan.ts's composePlan — GroupId's own
    // declared order, not alphabetical.
    expect(plan.groups.map((g: any) => g.id)).toEqual(["mac", "accounts", "access", "tools"]);

    const fda = plan.groups.find((g: any) => g.id === "mac").rows.find((r: any) => r.id === "perm.fda");
    expect(fda.status).toBe("error");
    expect(fda.action).toEqual({ type: "run", label: "Re-check", verb: ["setup", "status"] });
  }, 30_000);

  test("setup apply --from verify streams plan, only the verify step, then done", async () => {
    const res = await run(["setup", "apply", "--json", "--non-interactive", "--team-of-one", "--from", "verify"]);

    const events = res.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(events.length).toBeGreaterThanOrEqual(2);

    expect(events[0].event).toBe("plan");
    expect(Array.isArray(events[0].steps)).toBe(true);
    expect(events[0].steps.some((s: any) => s.id === "verify")).toBe(true);

    // `--from verify` resumes at the LAST contract step, so no other step
    // gets a `step` event on this run — only ones before `--from` are
    // skipped-without-an-event; a `step` event for anything else here would
    // mean resumeStart resumed at the wrong index.
    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents.length).toBeGreaterThan(0);
    expect(stepEvents.every((e) => e.id === "verify")).toBe(true);

    expect(events[events.length - 1]!.event).toBe("done");
  }, 45_000);

  test("deps resolve fzf --json parses", async () => {
    const res = await run(["deps", "resolve", "fzf", "--json"]);
    expect(res.exitCode).toBe(0);

    const out = JSON.parse(res.stdout.trim());
    expect(out.contract).toBe(1);
    expect(out).toHaveProperty("chosen");
  }, 15_000);

  test("team join with a code on argv exits 2 with code-on-argv", async () => {
    const res = await run(["team", "join", "SOME-CODE", "--json"]);
    expect(res.exitCode).toBe(2);

    const out = JSON.parse(res.stdout.trim());
    expect(out.error.code).toBe("code-on-argv");
  }, 15_000);

  test("uninstall --dry-run --json lists actions", async () => {
    const res = await run(["uninstall", "--dry-run", "--json"]);
    expect(res.exitCode).toBe(0);

    const out = JSON.parse(res.stdout.trim());
    expect(out.contract).toBe(1);
    expect(Array.isArray(out.actions)).toBe(true);
    // services.unregister is pushed unconditionally — the one action every
    // machine has regardless of what's actually installed.
    expect(out.actions[0].id).toBe("services.unregister");
  }, 15_000);

  test("update --json exits 2 app-not-running", async () => {
    const res = await run(["update", "--json"]);
    expect(res.exitCode).toBe(2);

    const out = JSON.parse(res.stdout.trim());
    expect(out.error.code).toBe("app-not-running");
  }, 15_000);
});
