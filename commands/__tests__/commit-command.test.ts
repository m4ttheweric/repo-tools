import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakePick, type PickFakeStep } from "../../lib/ui/pick-fake.ts";
import { __test__ as pickImplTest, type PickImpl } from "../../lib/ui/pick.ts";
import type { PickRequest, PickResult } from "../../lib/ui/protocol.ts";
import { commitFlow, runFilePicker } from "../commit.ts";
import { getChangedFiles } from "../../lib/commit-ops.ts";
import type { CommandContext } from "../../lib/command-tree.ts";

let fake: ReturnType<typeof installFakePick> | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

/**
 * installFakePick replays its whole script against EVERY runPick call made
 * while installed (one script per session, e.g. update/event steps ahead of
 * a result) — not a queue consumed across separate calls. commitFlow spawns
 * a fresh picker session each loop iteration, so exercising that loop needs
 * one distinct result per session instead: this dispenses `results` in
 * order, repeating the last one once exhausted.
 */
function installFakePickSequence(results: Array<Omit<PickResult, "t">>) {
  const calls: PickRequest[] = [];
  let i = 0;
  const fakeImpl: PickImpl = (req) => {
    calls.push(req);
    const chosen = results[Math.min(i, results.length - 1)]!;
    i++;
    return {
      update() {},
      modal: () => Promise.resolve(null),
      result: Promise.resolve({ t: "result", ...chosen }),
    };
  };
  pickImplTest.setImpl(fakeImpl);
  return {
    calls,
    restore(): void {
      pickImplTest.setImpl(undefined);
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

/** Fresh repo with one commit containing tracked.txt */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-commit-cmd-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@test");
  git(dir, "config", "user.name", "test");
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function resultStep(result: Partial<{ action: string; value: string | null; values: string[]; query: string }>): PickFakeStep {
  return { kind: "result", result: { action: "select", value: null, query: "", ...result } };
}

/** Mocks process.exit to throw a sentinel so the real test process never
 *  dies, and captures stderr writes made along the way. */
async function runCapturingExit(fn: () => Promise<void>): Promise<{ exitCode: number | undefined; stderr: string }> {
  let stderr = "";
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    await fn();
    return { exitCode: undefined, stderr };
  } catch {
    const exitCode = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode, stderr };
  } finally {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

describe("runFilePicker rows", () => {
  test("a tracked modified file gets a staged-marker + path left, +adds mint / -dels coral right", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "base\nextra1\nextra2\n");

    fake = installFakePick([resultStep({ action: "select", values: ["tracked.txt"] })]);
    await runFilePicker(dir, getChangedFiles(dir));

    const rows = fake.calls[0]!.request.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("tracked.txt");
    expect(rows[0]!.left).toEqual([
      { text: " M", tone: "dim" },
      { text: "  tracked.txt" },
    ]);
    expect(rows[0]!.right).toEqual([
      { text: "+2", tone: "mint" },
      { text: " " },
      { text: "-0", tone: "coral" },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an untracked file gets only a faint 'new' tag — no fabricated counts", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "loose.txt"), "x\n");

    fake = installFakePick([resultStep({ action: "select", values: ["loose.txt"] })]);
    await runFilePicker(dir, getChangedFiles(dir));

    const rows = fake.calls[0]!.request.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("loose.txt");
    expect(rows[0]!.left).toEqual([
      { text: "??", tone: "faint" },
      { text: "  loose.txt" },
    ]);
    expect(rows[0]!.right).toEqual([{ text: "new", tone: "faint" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("initialValues preselects every changed file (today's load:select-all)", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");
    writeFileSync(join(dir, "loose.txt"), "x\n");

    fake = installFakePick([resultStep({ action: "select", values: [] })]);
    const files = getChangedFiles(dir);
    await runFilePicker(dir, files);

    expect(fake.calls[0]!.request.initialValues?.slice().sort()).toEqual(
      files.map((f) => f.path).sort(),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  test("registers ctrl-d as a global 'discard' exit action", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    fake = installFakePick([resultStep({ action: "select", values: [] })]);
    await runFilePicker(dir, getChangedFiles(dir));

    expect(fake.calls[0]!.request.actions).toContainEqual({
      id: "discard",
      label: "discard",
      key: "ctrl-d",
      scope: "global",
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("runFilePicker outcome translation", () => {
  test("a normal selection returns the chosen paths", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");

    fake = installFakePick([resultStep({ action: "select", values: ["a.txt"] })]);
    const outcome = await runFilePicker(dir, getChangedFiles(dir));

    expect(outcome).toEqual({ action: "select", paths: ["a.txt"] });
    rmSync(dir, { recursive: true, force: true });
  });

  test("cancel (esc) returns null", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    fake = installFakePick([resultStep({ action: "cancel", value: null })]);
    const outcome = await runFilePicker(dir, getChangedFiles(dir));

    expect(outcome).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a discard action result carries the cursor row's path", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    fake = installFakePick([resultStep({ action: "discard", value: "tracked.txt" })]);
    const outcome = await runFilePicker(dir, getChangedFiles(dir));

    expect(outcome).toEqual({ action: "discard", paths: ["tracked.txt"] });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a discard action result with no cursor row carries no paths", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    fake = installFakePick([resultStep({ action: "discard", value: null })]);
    const outcome = await runFilePicker(dir, getChangedFiles(dir));

    expect(outcome).toEqual({ action: "discard", paths: [] });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a discard action result with a checked selection carries the whole selection (bulk), not just the cursor value", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    fake = installFakePick([
      resultStep({ action: "discard", value: "tracked.txt", values: ["a.txt", "c.txt"] }),
    ]);
    const outcome = await runFilePicker(dir, getChangedFiles(dir));

    expect(outcome).toEqual({ action: "discard", paths: ["a.txt", "c.txt"] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("commitFlow routing", () => {
  function ctxFor(repoRoot: string): CommandContext {
    return {
      identity: {
        repoName: "repo",
        identity: `path:${encodeURIComponent(repoRoot)}`,
        repoRoot,
        dataDir: repoRoot,
        remoteUrl: "",
        baseUrl: "",
      },
    };
  }

  test("a discard-action result routes into the existing discard branch, not the commit branch", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    // First session: ctrl-d with nothing under the cursor -- takes the
    // discard branch's own "nothing to discard" path (no confirm prompt,
    // loops back to a fresh picker session). Second session: esc -- aborts,
    // so the flow ends without ever reaching the commit-message prompt.
    const seq = installFakePickSequence([
      { action: "discard", value: null, query: "" },
      { action: "cancel", value: null, query: "" },
    ]);

    try {
      const { exitCode, stderr } = await runCapturingExit(() => commitFlow([], ctxFor(dir)));

      expect(exitCode).toBe(0);
      expect(stderr).toContain("nothing to discard");
      expect(stderr).not.toContain("Commit message");
      expect(seq.calls).toHaveLength(2);
    } finally {
      seq.restore();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a select result with nothing checked takes the commit branch's empty-selection path", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    fake = installFakePick([resultStep({ action: "select", values: [] })]);

    const { exitCode, stderr } = await runCapturingExit(() => commitFlow([], ctxFor(dir)));

    expect(exitCode).toBe(0);
    expect(stderr).toContain("nothing to commit");
    expect(stderr).not.toContain("nothing to discard");
    rmSync(dir, { recursive: true, force: true });
  });

  test("cancel aborts without touching git state", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "tracked.txt"), "changed\n");

    fake = installFakePick([resultStep({ action: "cancel", value: null })]);

    const { exitCode, stderr } = await runCapturingExit(() => commitFlow([], ctxFor(dir)));

    expect(exitCode).toBe(0);
    expect(stderr).toContain("aborted");
    rmSync(dir, { recursive: true, force: true });
  });
});
