import { describe, test, expect, spyOn } from "bun:test";
import { gatherHomeState, homeInit, type HomeProbes } from "../home.ts";
import { buildInitPlan } from "../../lib/home/init-plan.ts";
import type { ExecResult, ExecSeam } from "../../lib/home/init-exec.ts";
import type { AgeExecResult, AgeKeySeam } from "../../lib/home/age-key.ts";

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";

/** No key in the keychain yet; ensureAgeKey mints one — never touches the real keychain. */
class FakeAgeKeySeam implements AgeKeySeam {
  calls: string[][] = [];

  async run(cmd: string[]): Promise<AgeExecResult> {
    this.calls.push(cmd);
    if (cmd[1] === "find-generic-password") {
      return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    }
    if (cmd[0] === "age-keygen") {
      return { code: 0, stdout: `# public key: ${FAKE_PUBLIC_KEY}\n${FAKE_PRIVATE_KEY}\n`, stderr: "" };
    }
    if (cmd[1] === "add-generic-password") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

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
    private opts: {
      failRun?: (cmd: string[]) => boolean;
      throwOn?: (cmd: string[]) => boolean;
      stdout?: (cmd: string[]) => string;
    } = {},
  ) {}

  async run(cmd: string[]): Promise<ExecResult> {
    this.calls.push(cmd);
    if (this.opts.throwOn?.(cmd)) throw new Error(`spawn ${cmd[0]} ENOENT`);
    if (this.opts.failRun?.(cmd)) return { code: 1, stdout: "", stderr: "boom" };
    return { code: 0, stdout: this.opts.stdout?.(cmd) ?? "", stderr: "" };
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
  ageKeySeam: AgeKeySeam = new FakeAgeKeySeam(),
  args: string[] = [],
): Promise<{ exitCode: number | undefined }> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  try {
    await homeInit(args, {}, probes, exec, ageKeySeam);
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
  test("already-initialized: exits cleanly, runs no preflight or step, but still ensures the age key (idempotent)", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({ isGitRepo: () => true }), seam, ageKeySeam);

    expect(exitCode).toBeUndefined();
    expect(seam.calls).toEqual([]);
    expect(ageKeySeam.calls.some((c) => c[1] === "find-generic-password")).toBe(true);
  });

  test("already-initialized --dry-run: never touches the age key either", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({ isGitRepo: () => true }), seam, ageKeySeam, ["--dry-run"]);

    expect(exitCode).toBeUndefined();
    expect(ageKeySeam.calls).toEqual([]);
  });

  test("prefs-remote-unreadable: exits 1 and runs no preflight, init step, or age-key call", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const probes = fakeProbes({
      isGitRepo: (dir) => dir.endsWith("/user"), // hasUserClone, home itself is not a repo
      readFile: () => null, // config unreadable -> prefsRemoteUrl stays undefined
    });
    const { exitCode } = await runHomeInit(probes, seam, ageKeySeam);

    expect(exitCode).toBe(1);
    expect(seam.calls).toEqual([]);
    expect(ageKeySeam.calls).toEqual([]);
  });

  test("preflight failure (gh not authenticated) prints a hint, runs no init step, and never touches the age key", async () => {
    const seam = new FakeSeam({ failRun: (cmd) => cmd[0] === "gh" });
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({}), seam, ageKeySeam);

    expect(exitCode).toBe(1);
    // Only the gh check ran — filter-repo's check and every init step were
    // never reached.
    expect(seam.calls).toEqual([["gh", "auth", "status"]]);
    expect(ageKeySeam.calls).toEqual([]);
  });

  test("preflight: a missing binary (spawn throws) is caught as an install hint, not a raw crash", async () => {
    const seam = new FakeSeam({ throwOn: (cmd) => cmd[0] === "git" && cmd[1] === "filter-repo" });
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({}), seam, ageKeySeam);

    expect(exitCode).toBe(1);
    expect(seam.calls).toEqual([
      ["gh", "auth", "status"],
      ["git", "filter-repo", "--version"],
    ]);
    expect(ageKeySeam.calls).toEqual([]);
  });

  test("a fresh, fully successful init mints the age key as a distinct step after adoption, before returning", async () => {
    const seam = new FakeSeam({
      failRun: (cmd) => cmd[0] === "gh" && cmd[1] === "repo" && cmd[2] === "view", // not-found -> falls through to create
      stdout: (cmd) =>
        cmd[0] === "gh" && cmd[1] === "repo" && cmd[2] === "create" ? "https://github.com/testuser/mattstack-home\n" : "",
    });
    const ageKeySeam = new FakeAgeKeySeam();
    // Minimal state -> no cruft, no user clone: createRepo, gitInit,
    // writeGitignore, writeOwners, adoptCommit, push.
    const { exitCode } = await runHomeInit(fakeProbes({}), seam, ageKeySeam);

    expect(exitCode).toBeUndefined();
    // The init steps ran to completion before the age key was touched.
    expect(seam.calls.length).toBeGreaterThan(0);
    expect(ageKeySeam.calls.some((c) => c[1] === "find-generic-password")).toBe(true);
    expect(ageKeySeam.calls.some((c) => c[0] === "age-keygen")).toBe(true);
    expect(ageKeySeam.calls.some((c) => c[1] === "add-generic-password")).toBe(true);
  });

  test("--dry-run never touches the age key, even on a fresh (not-yet-initialized) home", async () => {
    const seam = new FakeSeam();
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({}), seam, ageKeySeam, ["--dry-run"]);

    expect(exitCode).toBeUndefined();
    expect(seam.calls).toEqual([]);
    expect(ageKeySeam.calls).toEqual([]);
  });

  test("a failing init step aborts before the age key is ever touched", async () => {
    const seam = new FakeSeam({ failRun: (cmd) => cmd.join(" ") === "git commit -m home: adopt the declarative layer" });
    const ageKeySeam = new FakeAgeKeySeam();
    const { exitCode } = await runHomeInit(fakeProbes({}), seam, ageKeySeam);

    expect(exitCode).toBe(1);
    expect(ageKeySeam.calls).toEqual([]);
  });
});
