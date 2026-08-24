import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { formatRunLine, formatRunDetail, runsList, runsShow, runsAbandon } from "../runs.ts";
import { closeStateDb } from "../../lib/state/index.ts";
import { deriveRepoIdentity, serializeIdentity } from "../../lib/settings/identity.ts";
import { updateRepoIndex } from "../../lib/repo-index.ts";
import type { DaemonResponse } from "../../lib/daemon-client.ts";

// mock.module mutates the live "../../lib/daemon-client.ts" namespace object
// IN PLACE, so this must be captured BEFORE any mock.module call in this
// file (same reasoning as commands/__tests__/worktree.test.ts).
const realDaemonClient = await import("../../lib/daemon-client.ts");
const realDaemonQuery = realDaemonClient.daemonQuery;
const realLastQueryTimedOut = realDaemonClient.lastQueryTimedOut;

/**
 * Mock process.exit to throw a sentinel so the real test process never
 * dies, and read the spies' recorded calls BEFORE mockRestore() -- bun's
 * mockRestore() clears .mock.calls, unlike jest's (matches
 * commands/__tests__/skills.test.ts's runExpectingCleanExit).
 */
async function runExpectingCleanExit(fn: () => Promise<void>): Promise<{ exitCode: number | undefined; errors: string[] }> {
  const errors: string[] = [];
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  try {
    await fn();
    return { exitCode: undefined, errors };
  } catch {
    const exitCode = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode, errors };
  } finally {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("rt runs formatting", () => {
  const run = { id: "20260821-010101-aaaa", repo: "alpha", work_type: "feature", pipeline: "default", status: "running", current_stage: "plan", spawned_by: null, started_at: 1755750000000, ended_at: null };

  test("formatRunLine shows id, repo, status, current stage", () => {
    const line = formatRunLine(run as any);
    expect(line).toContain("20260821-010101-aaaa");
    expect(line).toContain("alpha");
    expect(line).toContain("running");
    expect(line).toContain("plan");
  });

  test("formatRunDetail renders stages, fields, decisions sections", () => {
    const text = formatRunDetail({
      run: run as any,
      stages: [{ name: "plan", status: "done", attempt: 1, started_at: 1, ended_at: 2 }],
      fields: [{ key: "ticket", value: "ACME-1", produced_by: "plan", at: 1 }],
      decisions: [{ contract: "execution-strategy@1", scope: "run", selection: '{"tier":"direct-tdd"}', decided_by: "stage-plan", decided_at: 1 }],
      schemaAhead: false,
    } as any);
    expect(text).toContain("plan");
    expect(text).toContain("ticket");
    expect(text).toContain("execution-strategy@1");
  });

  test("formatRunDetail shows a failed stage's reason and detail_path", () => {
    const text = formatRunDetail({
      run: run as any,
      stages: [{ name: "gates", status: "failed", attempt: 1, started_at: 1, ended_at: 2, reason: "qa-islands assertion failed", detail_path: "/tmp/gates.log" }],
      fields: [],
      decisions: [],
      schemaAhead: false,
    } as any);
    expect(text).toContain("qa-islands assertion failed");
    expect(text).toContain("/tmp/gates.log");
  });
});

describe("rt runs --repo flag validation", () => {
  test("a dangling --repo with no value fails loudly instead of silently listing unscoped", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsList(["--repo"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--repo requires a value");
  });

  test("--repo immediately followed by another flag is treated as dangling, not a value", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsList(["--repo", "--json"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--repo requires a value");
  });

  test("runsShow rejects a dangling --repo the same way", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsShow(["20260821-010101-aaaa", "--repo"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--repo requires a value");
  });
});

describe("rt runs abandon argument validation", () => {
  test("runs abandon requires a run id", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsAbandon([]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("abandon needs a run id");
  });

  test("runs abandon rejects a dangling --reason", async () => {
    const { exitCode, errors } = await runExpectingCleanExit(() => runsAbandon(["some-id", "--reason"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--reason requires a value");
  });
});

/**
 * `runs:list`/`runs:get`/`runs:abandon` are identity-only on the daemon side
 * (lib/daemon/handlers/runs.ts) — a bare display name resolves nothing. This
 * CLI must reverse-resolve `--repo` the same way `rt worktree` does before
 * forwarding it.
 */
describe("rt runs --repo identity resolution", () => {
  interface Captured { cmd: string; payload?: Record<string, unknown> }

  function installFakeDaemon(response: DaemonResponse): Captured[] {
    const calls: Captured[] = [];
    mock.module("../../lib/daemon-client.ts", () => ({
      ...realDaemonClient,
      daemonQuery: async (cmd: string, payload?: Record<string, unknown>) => {
        calls.push({ cmd, payload });
        return response;
      },
      lastQueryTimedOut: () => false,
    }));
    return calls;
  }

  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  let home: string;
  let reposRoot: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-runs-cli-home-")));
    reposRoot = realpathSync(mkdtempSync(join(tmpdir(), "rt-runs-cli-repos-")));
    process.env.HOME = home;
    closeStateDb();
    process.chdir(home);
  });

  afterEach(() => {
    mock.module("../../lib/daemon-client.ts", () => ({
      ...realDaemonClient,
      daemonQuery: realDaemonQuery,
      lastQueryTimedOut: realLastQueryTimedOut,
    }));
    process.chdir(origCwd);
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(reposRoot, { recursive: true, force: true });
  });

  function makeGitRepo(name: string): string {
    const dir = realpathSync(mkdtempSync(join(reposRoot, `${name}-`)));
    execSync("git init -q -b main", { cwd: dir });
    return dir;
  }

  test("--repo <name> resolves to the serialized identity before it reaches the daemon", async () => {
    const repoPath = makeGitRepo("runs-named-repo");
    process.chdir(repoPath);
    const identity = serializeIdentity(await deriveRepoIdentity(repoPath));
    // A bare --repo name resolves by reverse-lookup against the repo index, so
    // the repo must be registered there for the name to match its basename.
    updateRepoIndex(identity, repoPath);
    process.chdir(home); // leave the repo — --repo must do the resolving, not cwd

    const calls = installFakeDaemon({ ok: true, data: { runs: [] } });

    await runsList(["--repo", basename(repoPath), "--json"]);

    const call = calls.find((c) => c.cmd === "runs:list");
    expect(call).toBeDefined();
    expect(call!.payload!.repo).toMatch(/^(remote|path):/);
    expect(call!.payload!.repo).toBe(identity);
  });

  test("--repo <path> derives the identity from the directory", async () => {
    const repoPath = makeGitRepo("runs-path-repo");
    const identity = serializeIdentity(await deriveRepoIdentity(repoPath));

    const calls = installFakeDaemon({ ok: true, data: { runs: [] } });

    await runsList(["--repo", repoPath, "--json"]);

    const call = calls.find((c) => c.cmd === "runs:list");
    expect(call?.payload?.repo).toBe(identity);
  });

  test("no --repo forwards undefined so the daemon lists across all repos", async () => {
    const calls = installFakeDaemon({ ok: true, data: { runs: [] } });

    await runsList(["--json"]);

    const call = calls.find((c) => c.cmd === "runs:list");
    expect(call?.payload?.repo).toBeUndefined();
  });

  test("runsShow resolves --repo the same way", async () => {
    const repoPath = makeGitRepo("runs-show-repo");
    const identity = serializeIdentity(await deriveRepoIdentity(repoPath));

    const calls = installFakeDaemon({ ok: true, data: { run: { id: "x" } } });

    await runsShow(["some-run-id", "--repo", repoPath, "--json"]);

    const call = calls.find((c) => c.cmd === "runs:get");
    expect(call?.payload?.repo).toBe(identity);
  });

  test("runsAbandon resolves --repo the same way", async () => {
    const repoPath = makeGitRepo("runs-abandon-repo");
    const identity = serializeIdentity(await deriveRepoIdentity(repoPath));

    const calls = installFakeDaemon({ ok: true, data: {} });

    await runsAbandon(["some-run-id", "--repo", repoPath]);

    const call = calls.find((c) => c.cmd === "runs:abandon");
    expect(call?.payload?.repo).toBe(identity);
  });

  test("an unresolvable --repo exits instead of sending a bogus key to the daemon", async () => {
    const calls = installFakeDaemon({ ok: true, data: { runs: [] } });
    const { exitCode, errors } = await runExpectingCleanExit(() => runsList(["--repo", "no-such-repo-anywhere"]));
    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("no-such-repo-anywhere");
    expect(calls.find((c) => c.cmd === "runs:list")).toBeUndefined();
  });
});
