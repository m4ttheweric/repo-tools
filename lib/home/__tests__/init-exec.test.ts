import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRealExecSeam, executeInitPlan, type ExecResult, type ExecSeam } from "../init-exec.ts";
import type { InitStep } from "../init-plan.ts";

type RecordedCall =
  | { kind: "run"; cmd: string[]; cwd?: string }
  | { kind: "writeFile"; path: string; content: string }
  | { kind: "removeDir"; path: string }
  | { kind: "mkTempDir" };

const noopLog = () => {};

/** Records every seam call in order; never touches a real fs or subprocess. */
class FakeExecSeam implements ExecSeam {
  calls: RecordedCall[] = [];

  constructor(
    private opts: {
      stdout?: (cmd: string[]) => string;
      failRun?: (cmd: string[]) => string | undefined;
      failWriteFile?: string;
    } = {},
  ) {}

  async run(cmd: string[], runOpts?: { cwd?: string }): Promise<ExecResult> {
    this.calls.push({ kind: "run", cmd, cwd: runOpts?.cwd });
    const failure = this.opts.failRun?.(cmd);
    if (failure) return { code: 1, stdout: "", stderr: failure };
    return { code: 0, stdout: this.opts.stdout?.(cmd) ?? "", stderr: "" };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push({ kind: "writeFile", path, content });
    if (this.opts.failWriteFile === path) throw new Error(`write failed: ${path}`);
  }

  async removeDir(path: string): Promise<void> {
    this.calls.push({ kind: "removeDir", path });
  }

  async mkTempDir(): Promise<string> {
    this.calls.push({ kind: "mkTempDir" });
    return "/tmp/rt-home-fold-test";
  }
}

describe("executeInitPlan", () => {
  test("createRepo: gh repo create with the plan's name, private, no owner qualifier", async () => {
    const seam = new FakeExecSeam({
      stdout: (cmd) => (cmd[0] === "gh" ? "https://github.com/testuser/mattstack-home\n" : ""),
    });
    const steps: InitStep[] = [{ kind: "createRepo", name: "mattstack-home" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "run", cmd: ["gh", "repo", "create", "mattstack-home", "--private"], cwd: undefined },
    ]);
  });

  test("createRepo: empty stdout fails the step instead of silently skipping remote add", async () => {
    const seam = new FakeExecSeam(); // no stdout scripted -> gh prints nothing
    const steps: InitStep[] = [
      { kind: "createRepo", name: "mattstack-home" },
      { kind: "gitInit", branch: "main" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe("createRepo");
      expect(result.stderr).toBe("gh repo create printed no repo URL");
    }
    // gitInit never ran.
    expect(seam.calls).toEqual([
      { kind: "run", cmd: ["gh", "repo", "create", "mattstack-home", "--private"], cwd: undefined },
    ]);
  });

  test("gitInit: init -b <branch>, then wires origin to the URL gh printed", async () => {
    const seam = new FakeExecSeam({
      stdout: (cmd) => (cmd[0] === "gh" ? "https://github.com/testuser/mattstack-home\n" : ""),
    });
    const steps: InitStep[] = [
      { kind: "createRepo", name: "mattstack-home" },
      { kind: "gitInit", branch: "main" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "run", cmd: ["gh", "repo", "create", "mattstack-home", "--private"], cwd: undefined },
      { kind: "run", cmd: ["git", "init", "-b", "main"], cwd: undefined },
      {
        kind: "run",
        cmd: ["git", "remote", "add", "origin", "https://github.com/testuser/mattstack-home"],
        cwd: undefined,
      },
    ]);
  });

  test("writeGitignore and writeOwners write the step's rendered content verbatim", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [
      { kind: "writeGitignore", content: "/rt/\n" },
      { kind: "writeOwners", content: "{}\n" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "writeFile", path: ".gitignore", content: "/rt/\n" },
      { kind: "writeFile", path: "snapshot-owners.jsonc", content: "{}\n" },
    ]);
  });

  test("deleteCruft removes each path via the seam, not shell rm", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [
      { kind: "deleteCruft", paths: ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"] },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "removeDir", path: "skills.jsonc.pre-pack" },
      { kind: "removeDir", path: "skills.jsonc.retired-backup" },
    ]);
  });

  test("foldInPrefs: temp clone, filter-repo in the clone, fetch HEAD + merge in the home repo, then remove user/.git and the temp clone", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "foldInPrefs" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "mkTempDir" },
      {
        kind: "run",
        cmd: ["git", "clone", "--no-hardlinks", "user", "/tmp/rt-home-fold-test"],
        cwd: undefined,
      },
      {
        kind: "run",
        cmd: ["git", "filter-repo", "--to-subdirectory-filter", "user"],
        cwd: "/tmp/rt-home-fold-test",
      },
      // HEAD, not a hardcoded branch name: the tmp clone's default branch
      // IS whatever the user/ remote's default branch is.
      { kind: "run", cmd: ["git", "fetch", "/tmp/rt-home-fold-test", "HEAD"], cwd: undefined },
      {
        kind: "run",
        cmd: [
          "git",
          "merge",
          "FETCH_HEAD",
          "--allow-unrelated-histories",
          "-m",
          "home: fold in mattstack-prefs history under user/",
        ],
        cwd: undefined,
      },
      { kind: "removeDir", path: "user/.git" },
      { kind: "removeDir", path: "/tmp/rt-home-fold-test" },
    ]);
  });

  test("foldInPrefs: the temp clone is removed even when a step inside it fails", async () => {
    const seam = new FakeExecSeam({
      failRun: (cmd) => (cmd[1] === "filter-repo" ? "filter-repo: boom" : undefined),
    });
    const steps: InitStep[] = [{ kind: "foldInPrefs" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe("foldInPrefs");
      expect(result.stderr).toBe("filter-repo: boom");
    }
    expect(seam.calls.at(-1)).toEqual({ kind: "removeDir", path: "/tmp/rt-home-fold-test" });
  });

  test("adoptCommit: add -A then commit with the plan's message", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "adoptCommit", message: "home: adopt the declarative layer" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([
      { kind: "run", cmd: ["git", "add", "-A"], cwd: undefined },
      { kind: "run", cmd: ["git", "commit", "-m", "home: adopt the declarative layer"], cwd: undefined },
    ]);
  });

  test("push: -u origin <branch>", async () => {
    const seam = new FakeExecSeam();
    const steps: InitStep[] = [{ kind: "push", branch: "main" }];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls).toEqual([{ kind: "run", cmd: ["git", "push", "-u", "origin", "main"], cwd: undefined }]);
  });

  test("runs a full plan's steps in order", async () => {
    const seam = new FakeExecSeam({
      stdout: (cmd) => (cmd[0] === "gh" ? "https://github.com/testuser/mattstack-home\n" : ""),
    });
    const steps: InitStep[] = [
      { kind: "createRepo", name: "mattstack-home" },
      { kind: "gitInit", branch: "main" },
      { kind: "writeGitignore", content: "/rt/\n" },
      { kind: "writeOwners", content: "{}\n" },
      { kind: "deleteCruft", paths: ["skills.jsonc.pre-pack"] },
      { kind: "adoptCommit", message: "home: adopt the declarative layer" },
      { kind: "foldInPrefs" },
      { kind: "push", branch: "main" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result).toEqual({ ok: true });
    expect(seam.calls.map((c) => c.kind)).toEqual([
      "run", // gh repo create
      "run", // git init
      "run", // git remote add origin
      "writeFile", // .gitignore
      "writeFile", // snapshot-owners.jsonc
      "removeDir", // deleteCruft
      "run", // git add -A
      "run", // git commit
      "mkTempDir",
      "run", // git clone
      "run", // git filter-repo
      "run", // git fetch
      "run", // git merge
      "removeDir", // user/.git
      "removeDir", // temp clone cleanup
      "run", // git push
    ]);
  });

  test("a failing step aborts the remaining steps and reports it", async () => {
    const seam = new FakeExecSeam({
      failWriteFile: ".gitignore",
      stdout: (cmd) => (cmd[0] === "gh" ? "https://github.com/testuser/mattstack-home\n" : ""),
    });
    const steps: InitStep[] = [
      { kind: "createRepo", name: "mattstack-home" },
      { kind: "gitInit", branch: "main" },
      { kind: "writeGitignore", content: "/rt/\n" },
      { kind: "writeOwners", content: "{}\n" },
      { kind: "adoptCommit", message: "home: adopt the declarative layer" },
      { kind: "push", branch: "main" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe("writeGitignore");
      expect(result.stderr).toContain(".gitignore");
    }
    // writeOwners, adoptCommit and push never ran.
    expect(seam.calls.map((c) => c.kind)).toEqual(["run", "run", "run", "writeFile"]);
  });

  test("a failing subprocess (non-zero exit) also aborts the remainder", async () => {
    const seam = new FakeExecSeam({
      failRun: (cmd) => (cmd[0] === "gh" ? "gh: not authenticated" : undefined),
    });
    const steps: InitStep[] = [
      { kind: "createRepo", name: "mattstack-home" },
      { kind: "gitInit", branch: "main" },
    ];

    const result = await executeInitPlan(steps, seam, noopLog);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe("createRepo");
      expect(result.stderr).toBe("gh: not authenticated");
    }
    expect(seam.calls).toEqual([
      { kind: "run", cmd: ["gh", "repo", "create", "mattstack-home", "--private"], cwd: undefined },
    ]);
  });
});

describe("createRealExecSeam", () => {
  test("run() defaults cwd to home, writeFile/removeDir resolve relative paths against home, absolute paths pass through", async () => {
    const home = mkdtempSync(join(tmpdir(), "rt-home-exec-test-"));
    try {
      const seam = createRealExecSeam(home);

      const pwd = await seam.run(["pwd"]);
      expect(pwd.code).toBe(0);
      expect(realpathSync(pwd.stdout.trim())).toBe(realpathSync(home));

      await seam.writeFile("hello.txt", "hi\n");
      expect(readFileSync(join(home, "hello.txt"), "utf8")).toBe("hi\n");

      await seam.removeDir("hello.txt");
      expect(existsSync(join(home, "hello.txt"))).toBe(false);

      const tmp = await seam.mkTempDir();
      expect(existsSync(tmp)).toBe(true);
      expect(tmp.startsWith(home)).toBe(false);

      const outsideFile = join(tmpdir(), `rt-home-exec-outside-${Date.now()}`);
      writeFileSync(outsideFile, "x");
      await seam.removeDir(outsideFile);
      expect(existsSync(outsideFile)).toBe(false);

      await seam.removeDir(tmp);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
