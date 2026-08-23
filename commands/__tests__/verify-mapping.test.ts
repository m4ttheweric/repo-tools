/**
 * rowsToChecks — maps a setup Plan's rows onto rt verify's flat CheckResult
 * list. `rt verify` no longer runs its own checks; it renders whatever
 * composePlan already computed, so this suite exercises the mapping rules
 * directly against hand-built Plan fixtures rather than re-deriving rows
 * through the validators.
 */

import { describe, expect, test } from "bun:test";
import { finalizePlan, row, type Plan, type Row, type TeamRef } from "../../lib/setup/contract.ts";
import { rowsToChecks } from "../verify.ts";

const TEAM: TeamRef = { slug: "", name: "", mode: "none" };

function planOf(rows: Row[]): Plan {
  return finalizePlan(TEAM, [{ id: "mac", title: "Your Mac", rows }], new Date("2026-01-01T00:00:00.000Z"));
}

function baseRow(overrides: Partial<Row> & Pick<Row, "id" | "status" | "required">): Row {
  return row({
    kind: "tool",
    title: overrides.id,
    why: "why",
    detail: "detail",
    ...overrides,
  });
}

/** rowsToChecks returns an array (group-mapped), so tests that build a one-row plan destructure through this to keep TS's array-index typing honest instead of asserting non-null at every call site. */
function oneCheck(rows: Row[], opts: { ci: boolean }) {
  const checks = rowsToChecks(planOf(rows), opts);
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

describe("rowsToChecks", () => {
  test("ready row -> pass", () => {
    const check = oneCheck([baseRow({ id: "tool.rt", status: "ready", required: true, detail: "rt v1.0.0" })], { ci: false });
    expect(check).toEqual({ name: "tool.rt", status: "pass", detail: "rt v1.0.0", severity: "critical" });
  });

  test("required row missing -> fail, critical", () => {
    const check = oneCheck([baseRow({ id: "tool.fzf", status: "missing", required: true, detail: "fzf not found" })], { ci: false });
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("critical");
  });

  test("optional row missing -> warn", () => {
    const check = oneCheck([baseRow({ id: "tool.editor", status: "missing", required: false, detail: "no editor found" })], { ci: false });
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  test("required row invalid, not ci -> fail, critical", () => {
    const check = oneCheck([baseRow({ id: "tool.herdr", status: "invalid", required: true, detail: "herdr 0.1.0 < 0.7.5" })], { ci: false });
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("critical");
  });

  test("required row error, not ci -> fail, critical", () => {
    const check = oneCheck([baseRow({ id: "tool.daemon", status: "error", required: true, detail: "boom" })], { ci: false });
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("critical");
  });

  test("required row needs-you, not ci -> fail, critical", () => {
    const check = oneCheck([baseRow({ id: "perm.fda", status: "needs-you", required: true, detail: "Not granted" })], { ci: false });
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("critical");
  });

  test("perm.fda needs-you in ci -> warn, never critical", () => {
    const check = oneCheck([baseRow({ id: "perm.fda", status: "needs-you", required: true, detail: "Not granted" })], { ci: true });
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  test("perm.login-items missing in ci -> warn, never critical", () => {
    const check = oneCheck([baseRow({ id: "perm.login-items", status: "missing", required: true, detail: "Not registered yet" })], { ci: true });
    expect(check.status).toBe("warn");
  });

  test("account.github missing in ci -> warn, never critical (credential-dependent, CI carries none)", () => {
    const check = oneCheck([baseRow({ id: "account.github", status: "missing", required: true, detail: "not signed in" })], { ci: true });
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  test("account.github missing, not ci -> still fail, critical", () => {
    const check = oneCheck([baseRow({ id: "account.github", status: "missing", required: true, detail: "not signed in" })], { ci: false });
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("critical");
  });

  test("access.forge needs-you in ci -> warn, never critical (network-reaching, CI carries no credentials)", () => {
    const check = oneCheck([baseRow({ id: "access.forge", status: "needs-you", required: true, detail: "could not reach forge" })], { ci: true });
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  test("tool.daemon needs-you in ci -> warn (existing behavior)", () => {
    const check = oneCheck([baseRow({ id: "tool.daemon", status: "needs-you", required: true, detail: "not booted (expected in CI)" })], { ci: true });
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  test("tool.daemon missing (not needs-you) in ci -> still fail, critical", () => {
    const check = oneCheck([baseRow({ id: "tool.daemon", status: "missing", required: true, detail: "run Install" })], { ci: true });
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("critical");
  });

  test("skipped row -> skip, info", () => {
    const check = oneCheck([baseRow({ id: "tool.legacy-dirs", status: "skipped", required: false, detail: "no editor found (works without this)" })], { ci: false });
    expect(check.status).toBe("skip");
    expect(check.severity).toBe("info");
  });

  test("checking row -> skip, info", () => {
    const check = oneCheck([baseRow({ id: "account.github", status: "checking", required: true, detail: "checking…" })], { ci: false });
    expect(check.status).toBe("skip");
    expect(check.severity).toBe("info");
  });

  test("name is the row id, not its title", () => {
    const check = oneCheck([baseRow({ id: "tool.rt", status: "ready", required: true, title: "rt binary", detail: "rt v1.0.0" })], { ci: false });
    expect(check.name).toBe("tool.rt");
  });

  test("an action on the row appends its label as a hint on the detail", () => {
    const check = oneCheck(
      [
        baseRow({
          id: "tool.fzf",
          status: "missing",
          required: true,
          detail: "fzf not found",
          action: { type: "link-bundled", label: "Use mattstack's", tool: "fzf" },
        }),
      ],
      { ci: false },
    );
    expect(check.detail).toBe("fzf not found — Use mattstack's");
  });

  test("no action on the row leaves detail untouched", () => {
    const check = oneCheck([baseRow({ id: "tool.rt", status: "ready", required: true, detail: "rt v1.0.0" })], { ci: false });
    expect(check.detail).toBe("rt v1.0.0");
  });

  test("maps every row across every group, in group/row order", () => {
    const plan: Plan = finalizePlan(
      TEAM,
      [
        { id: "mac", title: "Your Mac", rows: [baseRow({ id: "tool.macos", status: "ready", required: true, detail: "15.6" })] },
        { id: "tools", title: "Tools", rows: [baseRow({ id: "tool.fzf", status: "ready", required: true, detail: "fzf 0.50" })] },
      ],
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const checks = rowsToChecks(plan, { ci: false });
    expect(checks.map((c) => c.name)).toEqual(["tool.macos", "tool.fzf"]);
  });

  test("JSON summary counts match a mix of pass/fail/warn/skip", () => {
    const plan = planOf([
      baseRow({ id: "tool.rt", status: "ready", required: true, detail: "ready" }),
      baseRow({ id: "tool.fzf", status: "missing", required: true, detail: "missing" }),
      baseRow({ id: "tool.editor", status: "missing", required: false, detail: "missing" }),
      baseRow({ id: "tool.legacy-dirs", status: "skipped", required: false, detail: "skipped" }),
    ]);
    const checks = rowsToChecks(plan, { ci: false });
    const summary = {
      total: checks.length,
      pass: checks.filter((c) => c.status === "pass").length,
      fail: checks.filter((c) => c.status === "fail").length,
      warn: checks.filter((c) => c.status === "warn").length,
      skip: checks.filter((c) => c.status === "skip").length,
    };
    expect(summary).toEqual({ total: 4, pass: 1, fail: 1, warn: 1, skip: 1 });
  });
});
