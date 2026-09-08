import { describe, test, expect } from "bun:test";
import { settlePack, type ClaudeRunner } from "../pack-cache.ts";
import type { ExecResult } from "../probes.ts";

const ok: ExecResult = { code: 0, stdout: "", stderr: "" };
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: "", stderr });

/** Records argv verbs in order and replies from a per-verb script. */
function runner(script: Partial<Record<string, ExecResult>>): ClaudeRunner & { verbs: string[] } {
  const verbs: string[] = [];
  return {
    verbs,
    async run(args: string[]): Promise<ExecResult> {
      const verb = args[1]!;
      verbs.push(verb);
      return script[verb] ?? ok;
    },
  };
}

describe("settlePack", () => {
  test("install then disable leaves the pack installed and disabled", async () => {
    const r = runner({ install: ok, disable: ok });
    expect(await settlePack(r, "p@m", { teamAuthored: true })).toEqual({ kind: "installed", id: "p@m" });
    expect(r.verbs).toEqual(["install", "disable"]);
  });

  test("a disable that reports already-disabled is done, not a rollback", async () => {
    const r = runner({ install: ok, disable: fail('Plugin "p@m" is already disabled') });
    expect(await settlePack(r, "p@m", { teamAuthored: true })).toEqual({ kind: "installed", id: "p@m" });
    expect(r.verbs).toEqual(["install", "disable"]);
  });

  test("a failed disable rolls the install back", async () => {
    const r = runner({ install: ok, disable: fail("boom"), uninstall: ok });
    const outcome = await settlePack(r, "p@m", { teamAuthored: true });
    expect(outcome.kind).toBe("rolledBack");
    expect(r.verbs).toEqual(["install", "disable", "uninstall"]);
  });

  test("an unknown disable subcommand rolls back rather than leaving the pack enabled", async () => {
    const r = runner({ install: ok, disable: fail("unknown command"), uninstall: ok });
    expect((await settlePack(r, "p@m", { teamAuthored: true })).kind).toBe("rolledBack");
  });

  test("a rollback whose uninstall reports already-gone still counts as rolled back", async () => {
    const r = runner({ install: ok, disable: fail("boom"), uninstall: fail('Plugin "p@m" not found in installed plugins') });
    expect((await settlePack(r, "p@m", { teamAuthored: true })).kind).toBe("rolledBack");
  });

  test("a rollback that genuinely fails is recorded failed", async () => {
    const r = runner({ install: ok, disable: fail("boom"), uninstall: fail("permission denied") });
    const outcome = await settlePack(r, "p@m", { teamAuthored: true });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.detail).toContain("permission denied");
    expect(outcome.kind === "failed" && outcome.stage).toBe("rollback");
  });

  test("a clean install failure is terminal, and carries the stage and code plugins.install reports", async () => {
    const r = runner({ install: fail("network refused", 3) });
    const outcome = await settlePack(r, "p@m", { teamAuthored: true });
    expect(outcome).toEqual({ kind: "failed", id: "p@m", detail: "network refused", stage: "install", code: 3 });
    expect(r.verbs).toEqual(["install"]);
  });

  test("a timed-out install is ambiguous, so it uninstalls before recording failed and never disables", async () => {
    const r = runner({ install: fail("timeout", 124), uninstall: ok });
    expect((await settlePack(r, "p@m", { teamAuthored: true })).kind).toBe("failed");
    expect(r.verbs).toEqual(["install", "uninstall"]);
  });

  test("an already-installed pack is pre-existing: recorded current, enablement untouched", async () => {
    const r = runner({ install: fail("Plugin already installed") });
    expect(await settlePack(r, "p@m", { teamAuthored: true })).toEqual({ kind: "current", id: "p@m" });
    expect(r.verbs).toEqual(["install"]);
  });

  test("a trusted (non-team) pack is installed and handed back, never disabled and never enabled here", async () => {
    const r = runner({ install: ok });
    expect(await settlePack(r, "p@m", { teamAuthored: false })).toEqual({ kind: "installed", id: "p@m" });
    // The caller owns the enable, so this function issues exactly one command.
    expect(r.verbs).toEqual(["install"]);
  });

  test("a trusted pack is never rolled back, even though a team pack would be", async () => {
    const r = runner({ install: ok, disable: fail("boom"), uninstall: ok });
    expect(await settlePack(r, "p@m", { teamAuthored: false })).toEqual({ kind: "installed", id: "p@m" });
    expect(r.verbs).not.toContain("uninstall");
  });
});
