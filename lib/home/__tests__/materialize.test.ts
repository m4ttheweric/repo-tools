import { describe, test, expect } from "bun:test";
import {
  planMaterialize,
  runMaterialize,
  RT_OWN_STEP_KINDS,
  type MaterializeEnv,
  type MaterializeExecResult,
  type MaterializeExecSeam,
  type MaterializeStep,
} from "../materialize.ts";

const BASE_ENV: MaterializeEnv = {
  deckOnPath: false,
  deckHealthy: false,
  boardRepoPath: null,
  daemonInstalled: true,
  trackedRepos: [],
};

describe("planMaterialize", () => {
  test("always emits rtInterceptInstall, even with nothing else installed", () => {
    const steps = planMaterialize(BASE_ENV);
    expect(steps).toEqual([{ kind: "rtInterceptInstall" }]);
  });

  test("emits rtDaemonInstall only when the daemon isn't installed yet", () => {
    const notInstalled = planMaterialize({ ...BASE_ENV, daemonInstalled: false });
    expect(notInstalled).toContainEqual({ kind: "rtDaemonInstall" });

    const installed = planMaterialize({ ...BASE_ENV, daemonInstalled: true });
    expect(installed).not.toContainEqual({ kind: "rtDaemonInstall" });
  });

  test("reports tracked repos that aren't present locally, by name, in order", () => {
    const steps = planMaterialize({
      ...BASE_ENV,
      trackedRepos: [
        { name: "gitq", path: "/x/gitq", present: true },
        { name: "mr-board", path: "/x/mr-board", present: false },
        { name: "glance", path: "/x/glance", present: false },
      ],
    });
    expect(steps).toContainEqual({ kind: "reportMissingRepos", names: ["mr-board", "glance"] });
  });

  test("omits reportMissingRepos entirely when every tracked repo is present", () => {
    const steps = planMaterialize({
      ...BASE_ENV,
      trackedRepos: [{ name: "gitq", path: "/x/gitq", present: true }],
    });
    expect(steps.some((s) => s.kind === "reportMissingRepos")).toBe(false);
  });

  test("deck: on PATH + unhealthy plans deckSetup (deck setup restarts the live proxy, so it must only run when actually needed)", () => {
    const steps = planMaterialize({ ...BASE_ENV, deckOnPath: true, deckHealthy: false });
    expect(steps).toContainEqual({ kind: "deckSetup" });
    expect(steps.some((s) => s.kind === "reportDeckHealthy")).toBe(false);
  });

  test("deck: on PATH + already healthy skips deckSetup and reports healthy instead", () => {
    const steps = planMaterialize({ ...BASE_ENV, deckOnPath: true, deckHealthy: true });
    expect(steps).toContainEqual({ kind: "reportDeckHealthy" });
    expect(steps.some((s) => s.kind === "deckSetup")).toBe(false);
  });

  test("deck: off PATH plans neither deckSetup nor reportDeckHealthy, regardless of deckHealthy", () => {
    const steps = planMaterialize({ ...BASE_ENV, deckOnPath: false, deckHealthy: true });
    expect(steps.some((s) => s.kind === "deckSetup" || s.kind === "reportDeckHealthy")).toBe(false);
  });

  test("emits boardSetup with the repo path only when mr-board is cloned locally", () => {
    const withBoard = planMaterialize({ ...BASE_ENV, boardRepoPath: "/repos/mr-board" });
    expect(withBoard).toContainEqual({ kind: "boardSetup", repoPath: "/repos/mr-board" });

    expect(planMaterialize({ ...BASE_ENV, boardRepoPath: null }).some((s) => s.kind === "boardSetup")).toBe(false);
  });

  test("full table: every kind present in one plan, in the documented order", () => {
    const steps = planMaterialize({
      deckOnPath: true,
      deckHealthy: false,
      boardRepoPath: "/repos/mr-board",
      daemonInstalled: false,
      trackedRepos: [{ name: "gitq", path: "/x/gitq", present: false }],
    });
    expect(steps.map((s) => s.kind)).toEqual([
      "rtInterceptInstall",
      "rtDaemonInstall",
      "reportMissingRepos",
      "deckSetup",
      "boardSetup",
    ]);
  });
});

/** Records every {argv, opts} it was asked to run; scripts each call's result by exact argv match. */
class FakeExecSeam implements MaterializeExecSeam {
  calls: { argv: string[]; opts?: { timeoutMs?: number } }[] = [];
  constructor(private scripted: Map<string, MaterializeExecResult> = new Map()) {}

  script(argv: string[], result: MaterializeExecResult): void {
    this.scripted.set(argv.join(" "), result);
  }

  async run(argv: [string, ...string[]], opts?: { timeoutMs?: number }): Promise<MaterializeExecResult> {
    this.calls.push({ argv, opts });
    return this.scripted.get(argv.join(" ")) ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("runMaterialize", () => {
  test("rt-own steps shell out to the rt CLI itself, with a generous timeout", async () => {
    const seam = new FakeExecSeam();
    await runMaterialize([{ kind: "rtInterceptInstall" }, { kind: "rtDaemonInstall" }], seam);
    expect(seam.calls.map((c) => c.argv)).toEqual([
      ["rt", "intercept", "install"],
      ["rt", "daemon", "install"],
    ]);
    expect(seam.calls.every((c) => c.opts?.timeoutMs === 60_000)).toBe(true);
  });

  test("a custom rtBin (e.g. the compiled binary's own process.execPath) is used as both the resolved binary and argv[0] for rt-own steps", async () => {
    const seam = new FakeExecSeam();
    await runMaterialize([{ kind: "rtInterceptInstall" }, { kind: "rtDaemonInstall" }], seam, "/fake/rt-binary");
    expect(seam.calls.map((c) => c.argv)).toEqual([
      ["/fake/rt-binary", "intercept", "install"],
      ["/fake/rt-binary", "daemon", "install"],
    ]);
  });

  test("a custom rtBin also names the resolved binary in a spawn-failure message", async () => {
    const seam = new FakeExecSeam();
    seam.script(["/fake/rt-binary", "intercept", "install"], { stdout: "", stderr: "", exitCode: -1 });

    const [result] = await runMaterialize([{ kind: "rtInterceptInstall" }], seam, "/fake/rt-binary");
    expect(result!.stderr).toBe("could not run `/fake/rt-binary` — not found");
  });

  test("deckSetup shells out to deck setup, also with the generous timeout", async () => {
    const seam = new FakeExecSeam();
    await runMaterialize([{ kind: "deckSetup" }], seam);
    expect(seam.calls[0]!.argv).toEqual(["deck", "setup"]);
    expect(seam.calls[0]!.opts?.timeoutMs).toBe(60_000);
  });

  test("reportMissingRepos, reportDeckHealthy, and boardSetup never spawn a subprocess", async () => {
    const seam = new FakeExecSeam();
    const results = await runMaterialize(
      [
        { kind: "reportMissingRepos", names: ["gitq"] },
        { kind: "reportDeckHealthy" },
        { kind: "boardSetup", repoPath: "/repos/mr-board" },
      ],
      seam,
    );
    expect(seam.calls).toEqual([]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("reportDeckHealthy is always ok with the skip note", async () => {
    const seam = new FakeExecSeam();
    const [result] = await runMaterialize([{ kind: "reportDeckHealthy" }], seam);
    expect(result).toEqual({
      step: { kind: "reportDeckHealthy" },
      ok: true,
      stderr: "",
      stdout: "",
      note: "deck healthy — setup skipped",
    });
  });

  test("boardSetup is always report-only and ok, with the manual command in `note` (not `stderr`)", async () => {
    const seam = new FakeExecSeam();
    const [result] = await runMaterialize([{ kind: "boardSetup", repoPath: "/repos/mr-board" }], seam);
    expect(result).toEqual({
      step: { kind: "boardSetup", repoPath: "/repos/mr-board" },
      ok: true,
      stderr: "",
      stdout: "",
      note: 'run manually (interactive): cd "/repos/mr-board" && bun run scripts/setup.ts',
    });
  });

  test("a failing step is reported but does not stop the remaining steps from running", async () => {
    const seam = new FakeExecSeam();
    seam.script(["rt", "intercept", "install"], { stdout: "", stderr: "boom", exitCode: 1 });

    const results = await runMaterialize(
      [{ kind: "rtInterceptInstall" }, { kind: "deckSetup" }],
      seam,
    );

    expect(seam.calls.map((c) => c.argv)).toEqual([["rt", "intercept", "install"], ["deck", "setup"]]);
    expect(results[0]).toEqual({ step: { kind: "rtInterceptInstall" }, ok: false, stderr: "boom", stdout: "", note: "" });
    expect(results[1]!.ok).toBe(true);
  });

  test("a spawn failure (exitCode -1) names the missing binary rather than an empty message", async () => {
    const seam = new FakeExecSeam();
    seam.script(["deck", "setup"], { stdout: "", stderr: "", exitCode: -1 });

    const [result] = await runMaterialize([{ kind: "deckSetup" }], seam);
    expect(result!.ok).toBe(false);
    expect(result!.stderr).toBe("could not run `deck` — is it on PATH?");
  });

  test("rt-own steps capture stdout even on a clean exit — rt daemon install's approval guidance is printed there, not discarded", async () => {
    const seam = new FakeExecSeam();
    seam.script(["rt", "daemon", "install"], {
      stdout: "daemon not yet responding — approve it in System Settings\n",
      stderr: "",
      exitCode: 0,
    });

    const [result] = await runMaterialize([{ kind: "rtDaemonInstall" }], seam);
    expect(result!.ok).toBe(true);
    expect(result!.stdout).toBe("daemon not yet responding — approve it in System Settings");
  });

  test("deckSetup does NOT capture stdout — only RT_OWN_STEP_KINDS steps do", async () => {
    const seam = new FakeExecSeam();
    seam.script(["deck", "setup"], { stdout: "some deck output", stderr: "", exitCode: 0 });

    const [result] = await runMaterialize([{ kind: "deckSetup" }], seam);
    expect(result!.stdout).toBe("");
  });

  test("RT_OWN_STEP_KINDS names exactly the two rt-authored steps", () => {
    expect(RT_OWN_STEP_KINDS.has("rtInterceptInstall")).toBe(true);
    expect(RT_OWN_STEP_KINDS.has("rtDaemonInstall")).toBe(true);
    expect(RT_OWN_STEP_KINDS.has("deckSetup" as MaterializeStep["kind"])).toBe(false);
    expect(RT_OWN_STEP_KINDS.has("boardSetup" as MaterializeStep["kind"])).toBe(false);
    expect(RT_OWN_STEP_KINDS.has("reportMissingRepos" as MaterializeStep["kind"])).toBe(false);
    expect(RT_OWN_STEP_KINDS.has("reportDeckHealthy" as MaterializeStep["kind"])).toBe(false);
  });
});
