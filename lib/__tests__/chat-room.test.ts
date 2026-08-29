/**
 * Parity regression: the CLI's own sign-in and the daemon's `--pane`
 * sign-in both derive a room through this module -- these are the fixtures
 * the reviewer ran both codecs over to find the fix-round-2 divergence
 * (remote-kind matched; every path-kind identity split the room between a
 * pane-signed-in and a normally-signed-in agent for the same repo), plus
 * (fix round 3) the async daemon-side variant against the CLI's sync one,
 * including a linked worktree in a pool slot -- the case the reviewer
 * verified by hand resolves to the MAIN worktree's identity, not the linked
 * one's own path.
 */
import { execSync } from "child_process";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import { deriveRoomForCwdAsync, roomForIdentity } from "../chat-room.ts";
import { deriveRoomForCwd } from "../chat-room-cli.ts";

function initRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@example.com", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git commit --allow-empty -q -m init", { cwd: dir });
}

test("roomForIdentity: remote-kind takes the identity's last segment, slugified", () => {
  expect(roomForIdentity({ kind: "remote", id: "gitlab.example.com/acme/Acme-Dev" })).toBe("acme-dev");
});

test("roomForIdentity: path-kind pool slot takes the last TWO segments, so a bare pool-slot name never collides across repos", () => {
  expect(roomForIdentity({ kind: "path", id: "/Users/m/pool/gamma" })).toBe("pool-gamma");
});

test("roomForIdentity: path-kind local (non-pool) repo takes the last two segments the same way", () => {
  expect(roomForIdentity({ kind: "path", id: "/Users/m/work/my-notes" })).toBe("work-my-notes");
});

test("deriveRoomForCwd (the CLI's sync derivation) lands on exactly what roomForIdentity's path-kind rule would for the same repo -- a real local repo, not registered in any index, proves the parity end to end", () => {
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-parity-")));
  initRepo(repoDir);

  const room = deriveRoomForCwd(repoDir);
  expect(room).toBe(roomForIdentity({ kind: "path", id: repoDir }));
});

test("deriveRoomForCwd returns null outside any git work tree", () => {
  const stray = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-stray-")));
  expect(deriveRoomForCwd(stray)).toBeNull();
});

test("deriveRoomForCwdAsync (the actual daemon --pane derivation) agrees with deriveRoomForCwd (the CLI's) on a path-kind local repo", async () => {
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-async-path-")));
  initRepo(repoDir);

  expect(await deriveRoomForCwdAsync(repoDir)).toBe(deriveRoomForCwd(repoDir));
});

test("deriveRoomForCwdAsync agrees with deriveRoomForCwd on a remote-kind repo", async () => {
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-async-remote-")));
  initRepo(repoDir);
  execSync("git remote add origin git@gitlab.example.com:acme/Acme-Dev.git", { cwd: repoDir });

  const sync = deriveRoomForCwd(repoDir);
  expect(sync).toBe("acme-dev");
  expect(await deriveRoomForCwdAsync(repoDir)).toBe(sync);
});

test("deriveRoomForCwdAsync, run from a linked worktree in a pool slot, resolves to the MAIN worktree's identity -- not the linked worktree's own path", async () => {
  const mainDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-async-main-")));
  initRepo(mainDir);
  const linkedDir = join(realpathSync(mkdtempSync(join(tmpdir(), "chat-room-async-pool-"))), "gamma");
  execSync(`git worktree add -q -b pool-branch ${JSON.stringify(linkedDir)}`, { cwd: mainDir });

  const expected = roomForIdentity({ kind: "path", id: mainDir });
  expect(deriveRoomForCwd(linkedDir)).toBe(expected);
  expect(await deriveRoomForCwdAsync(linkedDir)).toBe(expected);
});

test("deriveRoomForCwdAsync returns null outside any git work tree", async () => {
  const stray = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-async-stray-")));
  expect(await deriveRoomForCwdAsync(stray)).toBeNull();
});
