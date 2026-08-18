import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ReadyStep } from "../config.ts";
import { changedSince, stepsToRun, runReadySteps } from "../ready.ts";

function makeRepo(): string {
  // realpathSync: git canonicalizes /var → /private/var on macOS (Global Constraints)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtready-")));
  execSync("git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init", {
    cwd: dir,
    shell: "/bin/zsh",
  });
  return dir;
}

describe("changedSince", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  test("returns touched files between two commits", async () => {
    const stamp = execSync("git rev-parse HEAD", { cwd: repo, shell: "/bin/zsh" }).toString().trim();
    execSync("mkdir -p db/schema", { cwd: repo, shell: "/bin/zsh" });
    writeFileSync(join(repo, "db", "schema", "x.sql"), "select 1;\n");
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -m add-schema", {
      cwd: repo,
      shell: "/bin/zsh",
    });

    const changed = await changedSince(repo, stamp);
    expect(changed).not.toBeNull();
    expect(changed).toContain("db/schema/x.sql");
  });

  test("returns null when the stamp is unknown to git", async () => {
    const changed = await changedSince(repo, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(changed).toBeNull();
  });
});

describe("stepsToRun", () => {
  const installStep: ReadyStep = { run: "bun install", when: "changed:bun.lock*" };
  const schemaStep: ReadyStep = { run: "db push", when: "changed:db/schema/**" };
  const noWhenStep: ReadyStep = { run: "echo hi" };
  const steps: ReadyStep[] = [installStep, schemaStep, noWhenStep];

  test("changed === null runs every step, including no-when steps", () => {
    expect(stepsToRun(steps, null)).toEqual(steps);
  });

  test("glob matching fires on a matching changed path", () => {
    const result = stepsToRun(steps, ["db/schema/x.sql"]);
    expect(result).toEqual([schemaStep]);
  });

  test("glob matching does not fire on a non-matching changed path", () => {
    const result = stepsToRun(steps, ["README.md"]);
    expect(result).toEqual([]);
  });

  test("no-when step is skipped when changed is a concrete list", () => {
    const result = stepsToRun([noWhenStep], ["README.md"]);
    expect(result).toEqual([]);
  });

  test("no-when step is included when changed === null", () => {
    const result = stepsToRun([noWhenStep], null);
    expect(result).toEqual([noWhenStep]);
  });
});

describe("runReadySteps", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  test("all steps succeed", async () => {
    const result = await runReadySteps(repo, [{ run: "true" }, { run: "true" }]);
    expect(result).toEqual({ ok: true });
  });

  test("executes in order and stops at the first failure", async () => {
    const marker = join(repo, "marker");
    const result = await runReadySteps(repo, [
      { run: `echo one > ${marker}` },
      { run: "false" },
      { run: `echo two >> ${marker}` },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe("false");
    }
    const content = execSync(`cat ${marker}`, { shell: "/bin/zsh" }).toString();
    expect(content).toBe("one\n");
  });

  test("failing step surfaces stdout+stderr in output", async () => {
    const result = await runReadySteps(repo, [{ run: "echo out-line; echo err-line >&2; exit 1" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain("out-line");
      expect(result.output).toContain("err-line");
    }
  });

  test("a failing step that writes only to stderr still surfaces its output", async () => {
    const result = await runReadySteps(repo, [{ run: "echo boom >&2; exit 1" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain("boom");
    }
  });
});
