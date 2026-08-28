/**
 * Parity regression (fix round 2): the CLI's own sign-in and the daemon's
 * `--pane` sign-in both derive a room through this module -- these are the
 * fixtures the reviewer ran both codecs over to find the divergence
 * (remote-kind matched; every path-kind identity split the room between a
 * pane-signed-in and a normally-signed-in agent for the same repo).
 */
import { execSync } from "child_process";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, test } from "bun:test";
import { deriveRoomForCwd, roomForIdentity } from "../chat-room.ts";

test("roomForIdentity: remote-kind takes the identity's last segment, slugified", () => {
  expect(roomForIdentity({ kind: "remote", id: "gitlab.example.com/acme/Acme-Dev" })).toBe("acme-dev");
});

test("roomForIdentity: path-kind pool slot takes the last TWO segments, so a bare pool-slot name never collides across repos", () => {
  expect(roomForIdentity({ kind: "path", id: "/Users/m/pool/gamma" })).toBe("pool-gamma");
});

test("roomForIdentity: path-kind local (non-pool) repo takes the last two segments the same way", () => {
  expect(roomForIdentity({ kind: "path", id: "/Users/m/work/my-notes" })).toBe("work-my-notes");
});

test("deriveRoomForCwd (the daemon's --pane derivation) lands on exactly what roomForIdentity's path-kind rule would for the same repo -- a real local repo, not registered in any index, proves the parity end to end", () => {
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-parity-")));
  execSync("git init -q", { cwd: repoDir });
  execSync("git config user.email t@example.com", { cwd: repoDir });
  execSync("git config user.name t", { cwd: repoDir });
  execSync("git commit --allow-empty -q -m init", { cwd: repoDir });

  const room = deriveRoomForCwd(repoDir);
  expect(room).toBe(roomForIdentity({ kind: "path", id: repoDir }));
});

test("deriveRoomForCwd returns null outside any git work tree", () => {
  const stray = realpathSync(mkdtempSync(join(tmpdir(), "chat-room-stray-")));
  expect(deriveRoomForCwd(stray)).toBeNull();
});
