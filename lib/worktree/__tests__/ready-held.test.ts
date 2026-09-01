/**
 * RT-98: the held-ladder snapshot the tray polls. Same on-disk store fixtures
 * as ready-approval.test.ts (real repo identity, authored team/user stores);
 * what this file pins is the SHAPE the daemon publishes (repo + ladder hash)
 * and the TTL that keeps a 10-second poll off the settings ladder.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { teamSettingsPath, userSettingsPath } from "../../rt-paths.ts";
import { deriveRepoIdentity, serializeIdentity } from "../../settings/identity.ts";
import { loadWorktreeRepoConfig } from "../config.ts";
import { readyLadderHash, writeReadyApproval } from "../ready-approval.ts";
import { heldReadyLadders, resetHeldReadyLaddersCache } from "../ready-held.ts";

/** The raw host/path form: what the settings store's `repos.<identity>` keys on. */
const IDENTITY = "gitlab.com/acme/held-snapshot";
/** The serialized wire form: what the daemon's repo index keys on. */
const WIRE = "remote:gitlab.com%2Facme%2Fheld-snapshot";
const REMOTE = "git@gitlab.com:acme/held-snapshot.git";
const LADDER = [{ run: "make setup" }];

function writeStore(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

function repoWithRemote(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtheld-")));
  execSync(`git init -q && git remote add origin ${REMOTE}`, { cwd: dir, shell: "/bin/zsh" });
  return dir;
}

function teamReady(steps: unknown): void {
  writeStore(teamSettingsPath("acme"), {
    repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 1, ready: steps } } },
  });
}

describe("heldReadyLadders", () => {
  const REAL_HOME = process.env.HOME;
  let repoPath: string;
  let index: Record<string, string>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtheld-home-")));
    repoPath = repoWithRemote();
    index = { [WIRE]: repoPath };
    resetHeldReadyLaddersCache();
  });

  afterEach(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
  });

  test("a held team ladder is reported with the hash an approval would pin", async () => {
    teamReady(LADDER);
    const cfg = await loadWorktreeRepoConfig(IDENTITY, repoPath);

    expect(await heldReadyLadders(index)).toEqual([
      {
        repo: WIRE,
        label: "held-snapshot",
        hash: readyLadderHash(cfg.ready),
        approveCommand: "rt worktree ready-approve held-snapshot",
      },
    ]);
  });

  test("a label shared by two registered repos falls back to the identity the command can resolve", async () => {
    teamReady(LADDER);
    const twin = realpathSync(mkdtempSync(join(tmpdir(), "rtheld-twin-")));
    execSync("git init -q && git remote add origin git@gitlab.com:other/held-snapshot.git", {
      cwd: twin,
      shell: "/bin/zsh",
    });

    const held = await heldReadyLadders({
      ...index,
      [serializeIdentity(await deriveRepoIdentity(twin))]: twin,
    });

    expect(held).toHaveLength(1);
    expect(held[0]!.approveCommand).toBe(`rt worktree ready-approve ${WIRE}`);
  });

  // The emitted command has to resolve THROUGH resolveRepoArg, which matches a
  // checkout's directory basename as well as an identity tail. A label unique
  // among tails but shared with another repo's directory name would resolve
  // ambiguously and the command would fail as spelled.
  test("a label colliding with another repo's directory basename falls back to the identity", async () => {
    teamReady(LADDER);
    const twinParent = realpathSync(mkdtempSync(join(tmpdir(), "rtheld-basename-")));
    const twin = join(twinParent, "held-snapshot");
    mkdirSync(twin, { recursive: true });
    execSync("git init -q && git remote add origin git@gitlab.com:other/unrelated-name.git", {
      cwd: twin,
      shell: "/bin/zsh",
    });

    const held = await heldReadyLadders({
      ...index,
      [serializeIdentity(await deriveRepoIdentity(twin))]: twin,
    });

    expect(held).toHaveLength(1);
    expect(held[0]!.approveCommand).toBe(`rt worktree ready-approve ${WIRE}`);
  });

  test("an approved ladder is absent", async () => {
    teamReady(LADDER);
    writeReadyApproval(IDENTITY, readyLadderHash(LADDER));

    expect(await heldReadyLadders(index)).toEqual([]);
  });

  test("a user-owned ladder is never reported: only team-authored shell is gated", async () => {
    writeStore(userSettingsPath(), {
      repos: { [IDENTITY]: { "rt.worktrees": { ready: [{ run: "echo mine" }] } } },
    });

    expect(await heldReadyLadders(index)).toEqual([]);
  });

  test("a repo with no derivable identity degrades to absent rather than throwing", async () => {
    teamReady(LADDER);
    const plainDir = realpathSync(mkdtempSync(join(tmpdir(), "rtheld-plain-")));

    expect(await heldReadyLadders({ "local/plain": plainDir })).toEqual([]);
  });

  test("a second call inside the TTL reuses the snapshot instead of re-reading the stores", async () => {
    teamReady(LADDER);
    const now = () => 1_000;
    expect(await heldReadyLadders(index, { now })).toHaveLength(1);

    // Approving between the two calls changes the underlying answer; the
    // cached call must not see it yet, which is what proves it did not
    // walk the settings ladder a second time.
    writeReadyApproval(IDENTITY, readyLadderHash(LADDER));

    expect(await heldReadyLadders(index, { now })).toHaveLength(1);
  });

  test("the snapshot recomputes once the TTL elapses", async () => {
    teamReady(LADDER);
    let clock = 1_000;
    const now = () => clock;
    expect(await heldReadyLadders(index, { ttlMs: 60_000, now })).toHaveLength(1);

    writeReadyApproval(IDENTITY, readyLadderHash(LADDER));
    clock += 60_001;

    expect(await heldReadyLadders(index, { ttlMs: 60_000, now })).toEqual([]);
  });
});
