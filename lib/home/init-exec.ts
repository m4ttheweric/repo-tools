/**
 * `rt home init` execution — turns an InitStep[] (lib/home/init-plan.ts) into
 * real git/gh/filter-repo calls, all routed through the injected ExecSeam so
 * tests never touch a real subprocess or fs.
 *
 * The seam is bound to the home directory: `run()` defaults its cwd to the
 * home repo, and `writeFile`/`removeDir` take paths relative to it. Only the
 * foldInPrefs temp clone overrides cwd explicitly.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { InitStep } from "./init-plan.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecSeam {
  run(cmd: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  mkTempDir(): Promise<string>;
}

export type InitResult = { ok: true } | { ok: false; failedStep: InitStep["kind"]; stderr: string };

const FOLD_MERGE_MESSAGE = "home: fold in mattstack-prefs history under user/";

type StepLog = (message: string) => void;

class StepFailed extends Error {
  constructor(public readonly stderr: string) {
    super(stderr);
  }
}

async function run(exec: ExecSeam, cmd: string[], opts?: { cwd?: string }): Promise<string> {
  const result = await exec.run(cmd, opts);
  if (result.code !== 0) throw new StepFailed(result.stderr);
  return result.stdout;
}

/** createRepo's stdout URL is carried forward for gitInit's `remote add`. */
interface ExecContext {
  createdRepoUrl?: string;
}

async function runStep(step: InitStep, exec: ExecSeam, log: StepLog, ctx: ExecContext): Promise<void> {
  switch (step.kind) {
    case "createRepo": {
      log(`creating GitHub repo ${step.name}`);
      const stdout = await run(exec, ["gh", "repo", "create", step.name, "--private"]);
      ctx.createdRepoUrl = stdout.trim().split("\n")[0] || undefined;
      return;
    }
    case "gitInit": {
      log(`git init -b ${step.branch}`);
      await run(exec, ["git", "init", "-b", step.branch]);
      if (ctx.createdRepoUrl) await run(exec, ["git", "remote", "add", "origin", ctx.createdRepoUrl]);
      return;
    }
    case "writeGitignore": {
      log("writing the boundary .gitignore");
      await exec.writeFile(".gitignore", step.content);
      return;
    }
    case "writeOwners": {
      log("writing snapshot-owners.jsonc");
      await exec.writeFile("snapshot-owners.jsonc", step.content);
      return;
    }
    case "deleteCruft": {
      for (const path of step.paths) {
        log(`removing stray cruft: ${path}`);
        await exec.removeDir(path);
      }
      return;
    }
    case "foldInPrefs": {
      log("folding mattstack-prefs history into user/");
      const tmp = await exec.mkTempDir();
      // --no-hardlinks: a plain local clone hardlinks objects into the tmp
      // clone; filter-repo rewrites history destructively, which would
      // corrupt the objects the real user/ clone still shares.
      await run(exec, ["git", "clone", "--no-hardlinks", "user", tmp]);
      await run(exec, ["git", "filter-repo", "--to-subdirectory-filter", "user"], { cwd: tmp });
      await run(exec, ["git", "fetch", tmp, "main"]);
      await run(exec, ["git", "merge", "FETCH_HEAD", "--allow-unrelated-histories", "-m", FOLD_MERGE_MESSAGE]);
      await exec.removeDir("user/.git");
      return;
    }
    case "adoptCommit": {
      log(`committing: ${step.message}`);
      await run(exec, ["git", "add", "-A"]);
      await run(exec, ["git", "commit", "-m", step.message]);
      return;
    }
    case "push": {
      log(`pushing -u origin ${step.branch}`);
      await run(exec, ["git", "push", "-u", "origin", step.branch]);
      return;
    }
  }
}

export async function executeInitPlan(steps: InitStep[], exec: ExecSeam, log: StepLog): Promise<InitResult> {
  const ctx: ExecContext = {};
  for (const step of steps) {
    try {
      await runStep(step, exec, log, ctx);
    } catch (err) {
      const stderr = err instanceof StepFailed ? err.stderr : err instanceof Error ? err.message : String(err);
      return { ok: false, failedStep: step.kind, stderr };
    }
  }
  return { ok: true };
}

/** The real seam: Bun.spawn-based capture, real fs writes/removal under `home`. */
export function createRealExecSeam(home: string): ExecSeam {
  return {
    async run(cmd, opts) {
      const proc = Bun.spawn(cmd, {
        cwd: opts?.cwd ?? home,
        // Bun.spawn resolves the executable against the PATH captured at
        // process start; a runtime process.env.PATH mutation is invisible to
        // it, so this must be a live reference, not a snapshot taken earlier.
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },
    async writeFile(path, content) {
      writeFileSync(join(home, path), content);
    },
    async removeDir(path) {
      rmSync(join(home, path), { recursive: true, force: true });
    },
    async mkTempDir() {
      mkdirSync(tmpdir(), { recursive: true });
      return mkdtempSync(join(tmpdir(), "rt-home-fold-"));
    },
  };
}
