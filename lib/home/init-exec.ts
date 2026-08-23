/**
 * `rt home init` execution — turns an InitStep[] (lib/home/init-plan.ts) into
 * real git/fs calls, all routed through the injected ExecSeam so tests never
 * touch a real subprocess or fs.
 *
 * The seam is bound to the home directory: `run()` defaults its cwd to the
 * home root, and every other method takes paths relative to it.
 */

import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
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
  mkdirp(path: string): Promise<void>;
  /** Any entry at all (file, dir, or symlink) — used to seed tracked files only into a genuinely empty clone. */
  exists(path: string): Promise<boolean>;
  /**
   * True for any entry that a symlink write must not clobber: a real file
   * OR a directory — both would be silently destroyed by unlink+symlink.
   * False for absent or an existing symlink (writeSymlink safely replaces
   * either of those).
   */
  blocksSymlink(path: string): Promise<boolean>;
  /** Idempotent: replaces whatever (if anything) already sits at `path`. Callers must confirm via blocksSymlink first — this never itself refuses a real file or directory. */
  writeSymlink(path: string, target: string): Promise<void>;
}

export type InitResult = { ok: true } | { ok: false; failedStep: InitStep["kind"]; stderr: string };

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

/** Seeds a tracked file only into a genuinely empty clone — a populated clone already carries it from its own history. */
async function writeIfAbsent(exec: ExecSeam, path: string, content: string, log: StepLog, label: string): Promise<void> {
  if (await exec.exists(path)) {
    log(`${label} already present — leaving it`);
    return;
  }
  log(`seeding ${label}`);
  await exec.writeFile(path, content);
}

async function runStep(step: InitStep, exec: ExecSeam, log: StepLog): Promise<void> {
  switch (step.kind) {
    case "ensureStateDirs": {
      for (const dir of step.dirs) {
        log(`creating ${dir}/`);
        await exec.mkdirp(dir);
      }
      return;
    }
    case "cloneUserRepo": {
      log(`cloning ${step.url} into user/`);
      await run(exec, ["git", "clone", step.url, "user"]);
      return;
    }
    case "initUserRepo": {
      log("initialising user/ as a local repo (no remote)");
      await run(exec, ["git", "init", "-b", "main", "user"]);
      return;
    }
    case "commitInitialUserRepo": {
      log("committing the initial user/ tree");
      await run(exec, ["git", "-C", "user", "add", "-A"]);
      await run(exec, ["git", "-C", "user", "commit", "-m", "initial home repo"]);
      return;
    }
    case "writeGitignore": {
      await writeIfAbsent(exec, "user/.gitignore", step.content, log, "user/.gitignore");
      return;
    }
    case "writeOwners": {
      await writeIfAbsent(exec, "user/snapshot-owners.jsonc", step.content, log, "user/snapshot-owners.jsonc");
      return;
    }
    case "writeMachineKey": {
      log(`writing machine-key (${step.key})`);
      await exec.writeFile("machine-key", step.key);
      return;
    }
    case "ensureProfileDir": {
      log(`creating user/local/${step.key}/`);
      await exec.mkdirp(join("user", "local", step.key));
      return;
    }
    case "writeSkillsSymlink": {
      // Re-checked here, not trusted from the plan-build-time probe: the
      // plan can be stale by the time this runs (a real file could appear
      // in between), and clobbering real content is worse than a stale
      // "skip" ever is.
      if (await exec.blocksSymlink("skills.jsonc")) {
        throw new StepFailed("a real file already exists at skills.jsonc — refusing to overwrite it");
      }
      log("linking skills.jsonc -> user/skills.jsonc");
      await exec.writeSymlink("skills.jsonc", join("user", "skills.jsonc"));
      return;
    }
  }
}

export async function executeInitPlan(steps: InitStep[], exec: ExecSeam, log: StepLog): Promise<InitResult> {
  for (const step of steps) {
    try {
      await runStep(step, exec, log);
    } catch (err) {
      const stderr = err instanceof StepFailed ? err.stderr : err instanceof Error ? err.message : String(err);
      return { ok: false, failedStep: step.kind, stderr };
    }
  }
  return { ok: true };
}

/** The real seam: Bun.spawn-based capture, real fs writes under `home`. */
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
    async mkdirp(path) {
      mkdirSync(join(home, path), { recursive: true });
    },
    async exists(path) {
      return existsSync(join(home, path));
    },
    async blocksSymlink(path) {
      try {
        return !lstatSync(join(home, path)).isSymbolicLink();
      } catch {
        return false; // absent
      }
    },
    async writeSymlink(path, target) {
      const full = join(home, path);
      try {
        unlinkSync(full);
      } catch {
        // nothing there yet — the common case on a fresh machine
      }
      symlinkSync(target, full);
    },
  };
}
