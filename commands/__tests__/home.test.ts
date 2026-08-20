import { describe, test, expect, spyOn } from "bun:test";
import { gatherHomeState, homeInit, type HomeProbes } from "../home.ts";
import { buildInitPlan } from "../../lib/home/init-plan.ts";
import type { ExecResult, ExecSeam } from "../../lib/home/init-exec.ts";

function fakeProbes(overrides: Partial<HomeProbes>): HomeProbes {
  return {
    isGitRepo: () => false,
    exists: () => false,
    listTeamClones: () => [],
    readFile: () => null,
    ...overrides,
  };
}

describe("gatherHomeState", () => {
  test("hasUserClone is true only when user/ is itself a git clone", () => {
    const probes = fakeProbes({
      isGitRepo: (dir) => dir.endsWith("/user"),
    });
    const state = gatherHomeState("/home", probes);
    expect(state.hasUserClone).toBe(true);
  });

  test("a plain (non-git) user/ directory does not count as a clone, and yields no foldInPrefs step", () => {
    const probes = fakeProbes({
      // user/ exists on disk but isn't a git repo — e.g. a half-materialized
      // or manually-created directory, not the mattstack-prefs clone.
      exists: (path) => path.endsWith("/user"),
      isGitRepo: () => false,
    });
    const state = gatherHomeState("/home", probes);
    expect(state.hasUserClone).toBe(false);

    const plan = buildInitPlan(state);
    expect(plan.steps.map((s) => s.kind)).not.toContain("foldInPrefs");
  });

  test("prefsRemoteUrl is parsed from user/.git/config while the clone still exists", () => {
    const probes = fakeProbes({
      isGitRepo: (dir) => dir.endsWith("/user"),
      readFile: (path) =>
        path.endsWith("/user/.git/config")
          ? '[remote "origin"]\n\turl = https://github.com/mattgoodwin/mattstack-prefs.git\n'
          : null,
    });
    const state = gatherHomeState("/home", probes);
    expect(state.prefsRemoteUrl).toBe("https://github.com/mattgoodwin/mattstack-prefs.git");
  });

  test("prefsRemoteUrl is undefined when there is no user clone, even if readFile would return something", () => {
    const probes = fakeProbes({
      isGitRepo: () => false,
      readFile: () => '[remote "origin"]\n\turl = https://example.com/should-not-be-read.git\n',
    });
    const state = gatherHomeState("/home", probes);
    expect(state.prefsRemoteUrl).toBeUndefined();
  });

  test("prefsRemoteUrl is undefined when the config can't be read or parsed", () => {
    const probes = fakeProbes({
      isGitRepo: (dir) => dir.endsWith("/user"),
      readFile: () => null,
    });
    const state = gatherHomeState("/home", probes);
    expect(state.prefsRemoteUrl).toBeUndefined();

    const plan = buildInitPlan(state);
    expect(plan.steps).toEqual([]);
    expect(plan.reason).toBe("prefs-remote-unreadable");
  });
});

/** Records argv only; used to prove preflight/idempotence run zero real steps. */
class FakeSeam implements ExecSeam {
  calls: string[][] = [];
  constructor(
    private opts: { failRun?: (cmd: string[]) => boolean; throwOn?: (cmd: string[]) => boolean } = {},
  ) {}

  async run(cmd: string[]): Promise<ExecResult> {
    this.calls.push(cmd);
    if (this.opts.throwOn?.(cmd)) throw new Error(`spawn ${cmd[0]} ENOENT`);
    if (this.opts.failRun?.(cmd)) return { code: 1, stdout: "", stderr: "boom" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async writeFile(): Promise<void> {}
  async removeDir(): Promise<void> {}
  async mkTempDir(): Promise<string> {
    return "/tmp/rt-home-fold-test";
  }
}

/** Runs `homeInit`, catching the `process.exit` call the failure paths make. */
async function runHomeInit(
  probes: HomeProbes,
  exec: ExecSeam,
): Promise<{ exitCode: number | undefined }> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  try {
    await homeInit([], {}, probes, exec);
    return { exitCode: undefined };
  } catch {
    const code = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode: code };
  } finally {
    exitSpy.mockRestore();
    (console.log as unknown as { mockRestore: () => void }).mockRestore();
    (console.error as unknown as { mockRestore: () => void }).mockRestore();
  }
}

describe("homeInit", () => {
  test("already-initialized: exits cleanly and runs no preflight or step", async () => {
    const seam = new FakeSeam();
    const { exitCode } = await runHomeInit(fakeProbes({ isGitRepo: () => true }), seam);

    expect(exitCode).toBeUndefined();
    expect(seam.calls).toEqual([]);
  });

  test("prefs-remote-unreadable: exits 1 and runs no preflight or step", async () => {
    const seam = new FakeSeam();
    const probes = fakeProbes({
      isGitRepo: (dir) => dir.endsWith("/user"), // hasUserClone, home itself is not a repo
      readFile: () => null, // config unreadable -> prefsRemoteUrl stays undefined
    });
    const { exitCode } = await runHomeInit(probes, seam);

    expect(exitCode).toBe(1);
    expect(seam.calls).toEqual([]);
  });

  test("preflight failure (gh not authenticated) prints a hint and runs no init step", async () => {
    const seam = new FakeSeam({ failRun: (cmd) => cmd[0] === "gh" });
    const { exitCode } = await runHomeInit(fakeProbes({}), seam);

    expect(exitCode).toBe(1);
    // Only the gh check ran — filter-repo's check and every init step were
    // never reached.
    expect(seam.calls).toEqual([["gh", "auth", "status"]]);
  });

  test("preflight: a missing binary (spawn throws) is caught as an install hint, not a raw crash", async () => {
    const seam = new FakeSeam({ throwOn: (cmd) => cmd[0] === "git" && cmd[1] === "filter-repo" });
    const { exitCode } = await runHomeInit(fakeProbes({}), seam);

    expect(exitCode).toBe(1);
    expect(seam.calls).toEqual([
      ["gh", "auth", "status"],
      ["git", "filter-repo", "--version"],
    ]);
  });
});
