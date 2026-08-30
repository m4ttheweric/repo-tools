/**
 * S094: per-repo steps schedule as independent promises under a concurrency
 * cap, so one repo's multi-minute install no longer stalls every other repo's
 * pass. Two invariants live here: a fast repo's create completes without
 * waiting behind a slow repo's (independent scheduling), and `withReconcilerHeld`
 * still drains the in-flight per-repo work before its held fn runs.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { writeJson } from "../../json-store.ts";
import { closeStateDb } from "../../state/index.ts";
import { machineSettingsPath, rtDir } from "../../rt-paths.ts";
import { deriveRepoIdentity } from "../../settings/identity.ts";
import { createWorktreeReconciler } from "../worktree-reconciler.ts";

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtcc-")));
  execSync(
    "git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: dir, shell: "/bin/zsh" },
  );
  return dir;
}

function addBareOrigin(repo: string): void {
  const bare = mkdtempSync(join(tmpdir(), "rtcc-bare-"));
  execSync(
    `git clone --bare ${repo} ${bare}/o.git && git -C ${repo} remote add origin ${bare}/o.git && git -C ${repo} fetch origin`,
    { shell: "/bin/zsh" },
  );
}

function readMachineStore(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(machineSettingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeMachineStore(obj: Record<string, unknown>): void {
  mkdirSync(join(machineSettingsPath(), ".."), { recursive: true });
  writeFileSync(machineSettingsPath(), JSON.stringify(obj));
}

async function ensureIdentity(repoPath: string, repoName: string): Promise<string> {
  let remote: string | null = null;
  try {
    remote = execSync("git config --get remote.origin.url", { cwd: repoPath, encoding: "utf8" }).trim() || null;
  } catch { /* no origin configured yet */ }
  if (!remote) {
    remote = `git@rttest:${repoName}.git`;
    execSync(`git remote add origin ${remote}`, { cwd: repoPath, shell: "/bin/zsh" });
  }

  const direct = await deriveRepoIdentity(repoPath);
  if (direct.kind === "remote") return direct.id;

  const identity = `rttest.local/${repoName}`;
  const store = readMachineStore();
  const overrides = { ...(store["rt.repoIdentityOverrides"] as Record<string, string> ?? {}), [remote]: identity };
  writeMachineStore({ ...store, "rt.repoIdentityOverrides": overrides });
  return identity;
}

async function declareWorktrees(repoPath: string, repoName: string, declared: unknown): Promise<void> {
  const identity = await ensureIdentity(repoPath, repoName);
  const store = readMachineStore();
  const repos = { ...(store.repos as Record<string, unknown> ?? {}), [identity]: { "rt.worktrees": declared } };
  writeMachineStore({ ...store, repos });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("reconciler per-repo concurrency (S094)", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtcc-home-")));
    closeStateDb();
    writeJson(join(rtDir(), "worktrees.json"), { enabled: true, killProcesses: true });
  });

  test("a fast repo's create finishes without waiting behind a slow repo's create", async () => {
    const slowName = "cc-slow";
    const fastName = "cc-fast";
    const slowRepo = makeRepo();
    const fastRepo = makeRepo();
    addBareOrigin(slowRepo);
    addBareOrigin(fastRepo);
    // Non-idle main on both so freshen skips them and only replenish's create
    // (the step under test) contributes timing.
    writeFileSync(join(slowRepo, "wip.txt"), "not idle\n");
    writeFileSync(join(fastRepo, "wip.txt"), "not idle\n");

    // Slow repo's ready step sleeps; its create emits `worktree:created` only
    // after the sleep. The fast repo has no ready steps, so its create emits
    // near-instantly. Serial scheduling processes the slow repo (iterated
    // first) to completion before the fast one, so the fast create's event
    // lands second; independent scheduling lets it land first.
    await declareWorktrees(slowRepo, slowName, {
      onDeck: 1,
      root: join(slowRepo, ".worktrees"),
      ready: [{ run: "sleep 2" }],
    });
    await declareWorktrees(fastRepo, fastName, {
      onDeck: 1,
      root: join(fastRepo, ".worktrees"),
    });

    const created: string[] = [];
    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [slowName]: slowRepo, [fastName]: fastRepo }),
      emit: (type: string, data: unknown) => {
        if (type === "worktree:created") created.push((data as { repo: string }).repo);
      },
      log: fakeLog(),
    });

    reconciler.kick();
    await waitFor(() => created.includes(fastName) && created.includes(slowName), 12_000);

    expect(created.indexOf(fastName)).toBeLessThan(created.indexOf(slowName));
    await waitFor(() => !reconciler.passInFlight(), 12_000);
  }, 30_000);

  test("withReconcilerHeld drains the in-flight slow create before the held fn runs", async () => {
    const slowName = "cc-hold-slow";
    const slowRepo = makeRepo();
    addBareOrigin(slowRepo);
    writeFileSync(join(slowRepo, "wip.txt"), "not idle\n");
    await declareWorktrees(slowRepo, slowName, {
      onDeck: 1,
      root: join(slowRepo, ".worktrees"),
      ready: [{ run: "sleep 2" }],
    });

    const order: string[] = [];
    const reconciler = createWorktreeReconciler({
      cache: { entries: {} },
      repoIndex: () => ({ [slowName]: slowRepo }),
      emit: (type: string) => {
        if (type === "worktree:created") order.push("created");
      },
      log: fakeLog(),
    });

    reconciler.kick();
    await waitFor(() => reconciler.creationInFlight(slowName) !== null, 5000);

    await reconciler.withReconcilerHeld(async () => {
      order.push("held");
    });

    // The held fn must observe the slow create already settled: a hold that
    // failed to drain would push "held" ahead of "created".
    expect(order).toEqual(["created", "held"]);
  }, 30_000);
});
