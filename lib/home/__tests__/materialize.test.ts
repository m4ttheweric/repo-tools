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

  test("emits deckSetup only when deck is on PATH", () => {
    expect(planMaterialize({ ...BASE_ENV, deckOnPath: true })).toContainEqual({ kind: "deckSetup" });
    expect(planMaterialize({ ...BASE_ENV, deckOnPath: false }).some((s) => s.kind === "deckSetup")).toBe(false);
  });

  test("emits boardSetup with the repo path only when mr-board is cloned locally", () => {
    const withBoard = planMaterialize({ ...BASE_ENV, boardRepoPath: "/repos/mr-board" });
    expect(withBoard).toContainEqual({ kind: "boardSetup", repoPath: "/repos/mr-board" });

    expect(planMaterialize({ ...BASE_ENV, boardRepoPath: null }).some((s) => s.kind === "boardSetup")).toBe(false);
  });

  test("full table: every kind present in one plan, in the documented order", () => {
    const steps = planMaterialize({
      deckOnPath: true,
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

/** Records every argv it was asked to run; scripts each call's result by exact argv match. */
class FakeExecSeam implements MaterializeExecSeam {
  calls: string[][] = [];
  constructor(private scripted: Map<string, MaterializeExecResult> = new Map()) {}

  script(argv: string[], result: MaterializeExecResult): void {
    this.scripted.set(argv.join(" "), result);
  }

  async run(argv: [string, ...string[]]): Promise<MaterializeExecResult> {
    this.calls.push(argv);
    return this.scripted.get(argv.join(" ")) ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

describe("runMaterialize", () => {
  test("rt-own steps shell out to the rt CLI itself", async () => {
    const seam = new FakeExecSeam();
    await runMaterialize([{ kind: "rtInterceptInstall" }, { kind: "rtDaemonInstall" }], seam);
    expect(seam.calls).toEqual([
      ["rt", "intercept", "install"],
      ["rt", "daemon", "install"],
    ]);
  });

  test("deckSetup shells out to deck setup", async () => {
    const seam = new FakeExecSeam();
    await runMaterialize([{ kind: "deckSetup" }], seam);
    expect(seam.calls).toEqual([["deck", "setup"]]);
  });

  test("reportMissingRepos and boardSetup never spawn a subprocess", async () => {
    const seam = new FakeExecSeam();
    const results = await runMaterialize(
      [{ kind: "reportMissingRepos", names: ["gitq"] }, { kind: "boardSetup", repoPath: "/repos/mr-board" }],
      seam,
    );
    expect(seam.calls).toEqual([]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test("boardSetup is always report-only and ok — mr-board's setup script prompts interactively and can't run unattended", async () => {
    const seam = new FakeExecSeam();
    const [result] = await runMaterialize([{ kind: "boardSetup", repoPath: "/repos/mr-board" }], seam);
    expect(result!.ok).toBe(true);
    expect(result!.stderr).toContain("/repos/mr-board");
    expect(result!.stderr.toLowerCase()).toContain("manual");
  });

  test("a failing step is reported but does not stop the remaining steps from running", async () => {
    const seam = new FakeExecSeam();
    seam.script(["rt", "intercept", "install"], { stdout: "", stderr: "boom", exitCode: 1 });

    const results = await runMaterialize(
      [{ kind: "rtInterceptInstall" }, { kind: "deckSetup" }],
      seam,
    );

    expect(seam.calls).toEqual([["rt", "intercept", "install"], ["deck", "setup"]]);
    expect(results[0]).toEqual({ step: { kind: "rtInterceptInstall" }, ok: false, stderr: "boom" });
    expect(results[1]!.ok).toBe(true);
  });

  test("a spawn failure (exitCode -1, no stderr) still yields a non-empty failure message", async () => {
    const seam = new FakeExecSeam();
    seam.script(["deck", "setup"], { stdout: "", stderr: "", exitCode: -1 });

    const [result] = await runMaterialize([{ kind: "deckSetup" }], seam);
    expect(result!.ok).toBe(false);
    expect(result!.stderr.length).toBeGreaterThan(0);
  });

  test("RT_OWN_STEP_KINDS names exactly the two rt-authored steps", () => {
    expect(RT_OWN_STEP_KINDS.has("rtInterceptInstall")).toBe(true);
    expect(RT_OWN_STEP_KINDS.has("rtDaemonInstall")).toBe(true);
    expect(RT_OWN_STEP_KINDS.has("deckSetup" as MaterializeStep["kind"])).toBe(false);
    expect(RT_OWN_STEP_KINDS.has("boardSetup" as MaterializeStep["kind"])).toBe(false);
    expect(RT_OWN_STEP_KINDS.has("reportMissingRepos" as MaterializeStep["kind"])).toBe(false);
  });
});
