import { describe, test, expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRealExecSeam, executeInitPlan, type ExecResult, type ExecSeam } from "../init-exec.ts";
import { buildInitPlan, STATE_DIR_NAMES, type InitStep } from "../init-plan.ts";

const REPO_URL = "https://github.com/m4ttheweric/mattstack-home";

type RecordedCall =
  | { kind: "run"; cmd: string[]; cwd?: string }
  | { kind: "writeFile"; path: string; content: string }
  | { kind: "mkdirp"; path: string }
  | { kind: "exists"; path: string }
  | { kind: "blocksSymlink"; path: string }
  | { kind: "writeSymlink"; path: string; target: string };

const noopLog = () => {};

/** Records every seam call in order; never touches a real fs or subprocess. */
class FakeExecSeam implements ExecSeam {
  calls: RecordedCall[] = [];

  constructor(
    private opts: {
      failRun?: (cmd: string[]) => string | undefined;
      exists?: (path: string) => boolean;
      blocksSymlink?: (path: string) => boolean;
    } = {},
  ) {}

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

  async exists(path: string): Promise<boolean> {
    this.calls.push({ kind: "exists", path });
    return this.opts.exists?.(path) ?? false;
  }

  async blocksSymlink(path: string): Promise<boolean> {
    this.calls.push({ kind: "blocksSymlink", path });
    return this.opts.blocksSymlink?.(path) ?? false;
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

  describe("commitInitialUserRepo", () => {
    test("commits with signing off — a global commit.gpgsign with an unusable key must not fail an init that needs no signature", async () => {
      const seam = new FakeExecSeam();

      const result = await executeInitPlan([{ kind: "commitInitialUserRepo" }], seam, noopLog);

      expect(result).toEqual({ ok: true });
      expect(seam.calls).toContainEqual({ kind: "run", cmd: ["git", "-c", "commit.gpgsign=false", "-C", "user", "commit", "-m", "initial home repo"], cwd: undefined });
    });

    test("nothing to commit is tolerated — a resumed init can reach here with the tree already committed", async () => {
      const seam = new FakeExecSeam({ failRun: (cmd) => (cmd.includes("commit") ? "nothing to commit, working tree clean" : undefined) });

      expect(await executeInitPlan([{ kind: "commitInitialUserRepo" }], seam, noopLog)).toEqual({ ok: true });
    });

    test("a real commit failure still aborts", async () => {
      const seam = new FakeExecSeam({ failRun: (cmd) => (cmd.includes("commit") ? "fatal: empty ident name not allowed" : undefined) });

      const result = await executeInitPlan([{ kind: "commitInitialUserRepo" }], seam, noopLog);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failedStep).toBe("commitInitialUserRepo");
    });
  });

  describe("writeGitignore / writeOwners — write-if-absent, decided at exec time", () => {
    test("an empty (freshly created) clone: neither file exists yet, so the ruled content is written", async () => {
      const seam = new FakeExecSeam({ exists: () => false });
      const steps: InitStep[] = [
        { kind: "writeGitignore", content: ".DS_Store\n*.sock\n*.tmp\n" },
        { kind: "writeOwners", content: "{}\n" },
      ];

      const result = await executeInitPlan(steps, seam, noopLog);

      expect(result).toEqual({ ok: true });
      expect(seam.calls).toEqual([
        { kind: "exists", path: "user/.gitignore" },
        { kind: "writeFile", path: "user/.gitignore", content: ".DS_Store\n*.sock\n*.tmp\n" },
        { kind: "exists", path: "user/snapshot-owners.jsonc" },
        { kind: "writeFile", path: "user/snapshot-owners.jsonc", content: "{}\n" },
      ]);
    });

    test("a populated clone: both files already exist (brought by the clone's own history) — left untouched", async () => {
      const seam = new FakeExecSeam({ exists: () => true });
      const steps: InitStep[] = [
        { kind: "writeGitignore", content: ".DS_Store\n*.sock\n*.tmp\n" },
        { kind: "writeOwners", content: "{}\n" },
      ];

      const result = await executeInitPlan(steps, seam, noopLog);

      expect(result).toEqual({ ok: true });
      expect(seam.calls).toEqual([
        { kind: "exists", path: "user/.gitignore" },
        { kind: "exists", path: "user/snapshot-owners.jsonc" },
      ]);
      expect(seam.calls.some((c) => c.kind === "writeFile")).toBe(false);
    });
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

  describe("writeSkillsSymlink — re-checked at exec time, never trusts the plan-build-time probe", () => {
    test("nothing (or a symlink) at the root path: links skills.jsonc -> user/skills.jsonc", async () => {
      const seam = new FakeExecSeam({ blocksSymlink: () => false });
      const steps: InitStep[] = [{ kind: "writeSkillsSymlink" }];

      const result = await executeInitPlan(steps, seam, noopLog);

      expect(result).toEqual({ ok: true });
      expect(seam.calls).toEqual([
        { kind: "blocksSymlink", path: "skills.jsonc" },
        { kind: "writeSymlink", path: "skills.jsonc", target: join("user", "skills.jsonc") },
      ]);
    });

    test("a REAL file at the root path: the step fails, and writeSymlink (so unlink) is never called", async () => {
      const seam = new FakeExecSeam({ blocksSymlink: () => true });
      const steps: InitStep[] = [{ kind: "writeSkillsSymlink" }];

      const result = await executeInitPlan(steps, seam, noopLog);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failedStep).toBe("writeSkillsSymlink");
        expect(result.stderr).toContain("refusing to overwrite");
      }
      expect(seam.calls).toEqual([{ kind: "blocksSymlink", path: "skills.jsonc" }]);
      expect(seam.calls.some((c) => c.kind === "writeSymlink")).toBe(false);
    });
  });

  test("runs a full fresh-machine plan's steps in order", async () => {
    const seam = new FakeExecSeam({ exists: () => false, blocksSymlink: () => false });
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
      "mkdirp", // ci-attendants
      "mkdirp", // work
      "mkdirp", // teams
      "run", // git clone
      "exists", // user/.gitignore
      "writeFile", // user/.gitignore
      "exists", // user/snapshot-owners.jsonc
      "writeFile", // user/snapshot-owners.jsonc
      "writeFile", // machine-key
      "mkdirp", // user/local/mbp-14
      "blocksSymlink", // skills.jsonc
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
  test("run() defaults cwd to home; mkdirp/writeFile/exists/writeSymlink resolve relative to home", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-test-"));
    try {
      const seam = createRealExecSeam(home);

      const pwd = await seam.run(["pwd"]);
      expect(pwd.code).toBe(0);
      expect(realpathSync(pwd.stdout.trim())).toBe(realpathSync(home));

      await seam.mkdirp(join("user", "local", "mbp-14"));
      expect(existsSync(join(home, "user", "local", "mbp-14"))).toBe(true);

      expect(await seam.exists("user/skills.jsonc")).toBe(false);
      await seam.writeFile("user/skills.jsonc", "{}\n");
      expect(readFileSync(join(home, "user", "skills.jsonc"), "utf8")).toBe("{}\n");
      expect(await seam.exists("user/skills.jsonc")).toBe(true);

      expect(await seam.blocksSymlink("skills.jsonc")).toBe(false); // absent
      await seam.writeSymlink("skills.jsonc", join("user", "skills.jsonc"));
      const st = lstatSync(join(home, "skills.jsonc"));
      expect(st.isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, "skills.jsonc"))).toBe(join("user", "skills.jsonc"));
      expect(await seam.blocksSymlink("skills.jsonc")).toBe(false); // a symlink, not a real file

      // writeSymlink replaces whatever was already there.
      await seam.writeSymlink("skills.jsonc", join("user", "skills.jsonc"));
      expect(lstatSync(join(home, "skills.jsonc")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // blocksSymlink is the guard runStep checks before any unlink; a genuine file
  // (not a fake seam) must trip it, or writeSymlink would clobber user content.
  test("blocksSymlink is true for a genuine file, distinguishing it from a symlink", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-realfile-"));
    try {
      const seam = createRealExecSeam(home);
      writeFileSync(join(home, "skills.jsonc"), '{"real": "content"}\n');

      expect(await seam.blocksSymlink("skills.jsonc")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A directory at the root path is exactly as unsafe to unlink+symlink over
  // as a real file — the name says "blocks a symlink write", not "is a file",
  // so this must read true too.
  test("blocksSymlink is true for a directory, not just a plain file", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-realdir-"));
    try {
      const seam = createRealExecSeam(home);
      mkdirSync(join(home, "skills.jsonc"));

      expect(await seam.blocksSymlink("skills.jsonc")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("executeInitPlan(writeSkillsSymlink) against a real skills.jsonc file: fails, leaves the file byte-identical, creates no symlink", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-clobber-guard-"));
    try {
      const original = '{"real": "content", "do-not-touch": true}\n';
      writeFileSync(join(home, "skills.jsonc"), original);
      const seam = createRealExecSeam(home);

      const result = await executeInitPlan([{ kind: "writeSkillsSymlink" }], seam, noopLog);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failedStep).toBe("writeSkillsSymlink");
        expect(result.stderr).toContain("refusing to overwrite");
      }
      const st = lstatSync(join(home, "skills.jsonc"));
      expect(st.isSymbolicLink()).toBe(false);
      expect(readFileSync(join(home, "skills.jsonc"), "utf8")).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("writeGitignore/writeOwners against a real, already-populated clone: left byte-identical", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-populated-clone-"));
    try {
      const seam = createRealExecSeam(home);
      const userDir = join(home, "user");
      mkdirSync(userDir, { recursive: true });
      const existingGitignore = "# hand-curated, from the clone's own history\n";
      const existingOwners = '{ "claimview": "matt" }\n';
      writeFileSync(join(userDir, ".gitignore"), existingGitignore);
      writeFileSync(join(userDir, "snapshot-owners.jsonc"), existingOwners);

      const result = await executeInitPlan(
        [
          { kind: "writeGitignore", content: ".DS_Store\n*.sock\n*.tmp\n" },
          { kind: "writeOwners", content: "{}\n" },
        ],
        seam,
        noopLog,
      );

      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(userDir, ".gitignore"), "utf8")).toBe(existingGitignore);
      expect(readFileSync(join(userDir, "snapshot-owners.jsonc"), "utf8")).toBe(existingOwners);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("writeGitignore/writeOwners against a genuinely empty clone: seeds the ruled content", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-empty-clone-"));
    try {
      const seam = createRealExecSeam(home);
      mkdirSync(join(home, "user"), { recursive: true });

      const result = await executeInitPlan(
        [
          { kind: "writeGitignore", content: ".DS_Store\n*.sock\n*.tmp\n" },
          { kind: "writeOwners", content: "{}\n" },
        ],
        seam,
        noopLog,
      );

      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(home, "user", ".gitignore"), "utf8")).toBe(".DS_Store\n*.sock\n*.tmp\n");
      expect(readFileSync(join(home, "user", "snapshot-owners.jsonc"), "utf8")).toBe("{}\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
