import { describe, test, expect } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRealExecSeam, executeInitPlan, type ExecResult, type ExecSeam } from "../init-exec.ts";
import { buildInitPlan, STATE_DIR_NAMES, type InitStep } from "../init-plan.ts";

const REPO_URL = "https://github.com/m4ttheweric/mattstack-home";

type RecordedCall =
  | { kind: "run"; cmd: string[]; cwd?: string }
  | { kind: "writeFile"; path: string; content: string }
  | { kind: "mkdirp"; path: string }
  | { kind: "writeSymlink"; path: string; target: string };

const noopLog = () => {};

/** Records every seam call in order; never touches a real fs or subprocess. */
class FakeExecSeam implements ExecSeam {
  calls: RecordedCall[] = [];

  constructor(private opts: { failRun?: (cmd: string[]) => string | undefined } = {}) {}

  async run(cmd: string[], runOpts?: { cwd?: string }): Promise<ExecResult> {
    this.calls.push({ kind: "run", cmd, cwd: runOpts?.cwd });
    const failure = this.opts.failRun?.(cmd);
    if (failure) return { code: 1, stdout: "", stderr: failure };
    return { code: 0, stdout: "", stderr: "" };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push({ kind: "writeFile", path, content });
  }

  async mkdirp(path: string): Promise<void> {
    this.calls.push({ kind: "mkdirp", path });
  }

  async writeSymlink(path: string, target: string): Promise<void> {
    this.calls.push({ kind: "writeSymlink", path, target });
  }
}

describe("executeInitPlan", () => {
  test("ensureStateDirs: mkdirp's each missing dir in order", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "ensureStateDirs", dirs: ["rt", "work"] }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "mkdirp", path: "rt" },
      { kind: "mkdirp", path: "work" },
    ]);
  });

  test("cloneUserRepo: git clone <url> user, cwd defaults to home", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "cloneUserRepo", url: REPO_URL }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([{ kind: "run", cmd: ["git", "clone", REPO_URL, "user"], cwd: undefined }]);
  });

  test("cloneUserRepo: a failing clone aborts and reports it", async () => {
    const seam = new FakeExecSeam({ failRun: () => "fatal: could not read from remote repository" });
    const steps: InitStep[] = [{ kind: "cloneUserRepo", url: REPO_URL }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe("cloneUserRepo");
      expect(result.stderr).toContain("could not read from remote");
    }
  });

  test("writeGitignore and writeOwners write into the user repo, not the root", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [
      { kind: "writeGitignore", content: ".DS_Store\n*.sock\n*.tmp\n" },
      { kind: "writeOwners", content: "{}\n" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "writeFile", path: "user/.gitignore", content: ".DS_Store\n*.sock\n*.tmp\n" },
      { kind: "writeFile", path: "user/snapshot-owners.jsonc", content: "{}\n" },
    ]);
  });

  test("writeMachineKey: writes the key to the root machine-key file", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "writeMachineKey", key: "mbp-14" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([{ kind: "writeFile", path: "machine-key", content: "mbp-14" }]);
  });

  test("ensureProfileDir: mkdirp's user/local/<key>/", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "ensureProfileDir", key: "mbp-14" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([{ kind: "mkdirp", path: join("user", "local", "mbp-14") }]);
  });

  test("writeSkillsSymlink: links the root path to user/skills.jsonc", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "writeSkillsSymlink" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([{ kind: "writeSymlink", path: "skills.jsonc", target: join("user", "skills.jsonc") }]);
  });

  test("runs a full fresh-machine plan's steps in order", async () => {
    const seam = new FakeExecSeam();
    const steps = buildInitPlan(
      {
        userRepoPresent: false,
        machineKeyFilePresent: false,
        profileDirPresent: false,
        skillsSymlinkPresent: false,
        skillsSymlinkBlocked: false,
        stateDirsMissing: [...STATE_DIR_NAMES],
      },
      { url: REPO_URL, machineKey: "mbp-14" },
    ).steps;

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls.map((c) => c.kind)).toEqual([
      "mkdirp", // rt
      "mkdirp", // deck
      "mkdirp", // shepherdr
      "mkdirp", // repos
      "mkdirp", // work
      "mkdirp", // teams
      "run", // git clone
      "writeFile", // user/.gitignore
      "writeFile", // user/snapshot-owners.jsonc
      "writeFile", // machine-key
      "mkdirp", // user/local/mbp-14
      "writeSymlink", // skills.jsonc
    ]);
  });

  test("a failing step aborts the remaining steps and reports it", async () => {
    const seam = new FakeExecSeam({ failRun: (cmd) => (cmd[0] === "git" ? "fatal: repository not found" : undefined) });
    const steps: InitStep[] = [
      { kind: "cloneUserRepo", url: REPO_URL },
      { kind: "writeGitignore", content: ".DS_Store\n" },
      { kind: "writeMachineKey", key: "mbp-14" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe("cloneUserRepo");
      expect(result.stderr).toContain("not found");
    }
    // writeGitignore and writeMachineKey never ran.
    expect(seam.calls).toEqual([{ kind: "run", cmd: ["git", "clone", REPO_URL, "user"], cwd: undefined }]);
  });
});

describe("createRealExecSeam", () => {
  test("run() defaults cwd to home; mkdirp/writeFile/writeSymlink resolve relative to home", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-test-"));
    try {
      const seam = createRealExecSeam(home);

      const pwd = await seam.run(["pwd"]);
      expect(pwd.code).toBe(0);
      expect(realpathSync(pwd.stdout.trim())).toBe(realpathSync(home));

      await seam.mkdirp(join("user", "local", "mbp-14"));
      expect(existsSync(join(home, "user", "local", "mbp-14"))).toBe(true);

      await seam.writeFile("user/skills.jsonc", "{}\n");
      expect(readFileSync(join(home, "user", "skills.jsonc"), "utf8")).toBe("{}\n");

      await seam.writeSymlink("skills.jsonc", join("user", "skills.jsonc"));
      const st = lstatSync(join(home, "skills.jsonc"));
      expect(st.isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, "skills.jsonc"))).toBe(join("user", "skills.jsonc"));

      // writeSymlink replaces whatever was already there.
      await seam.writeSymlink("skills.jsonc", join("user", "skills.jsonc"));
      expect(lstatSync(join(home, "skills.jsonc")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
