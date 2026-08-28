import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { execSync } from "child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../../state/index.ts";
import { createChatHandlers, inviteText, renderWelcome, type InboxDeps } from "../handlers/chat.ts";
import { herdrRequest } from "../../herdr/client.ts";
import { fakeHerdr, HerdrFakeError, type FakeHerdrHandler } from "../../herdr/__tests__/fake-herdr.ts";
import { deriveRoomForCwd } from "../../chat-room.ts";
import { runCapture } from "../../subprocess.ts";
import { drainNotifications, loadNotificationPrefs, peekNotifications, saveNotificationPrefs } from "../../notifier.ts";
import { setSetting } from "../../settings/write.ts";
import { AGENT_NAMES } from "../../chat-names.ts";

/** A real local git repo, no remote: the daemon's `deriveRoomForCwdAsync` (via deriveRepoIdentity) needs a real toplevel and a real `git worktree list`/`config --get` to resolve against, not a stub `.git/worktrees` dir. */
function initRepo(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@example.com", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  execSync("git commit --allow-empty -q -m init", { cwd: dir });
}

/** inboxAlive checks process.kill(pid,0) and existsSync(socketPath) for real; a live pid and a real (empty) file satisfy both without a listener. */
function fakeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-h-sock-"));
  const p = join(dir, "s.sock");
  writeFileSync(p, "");
  return p;
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops.length = 0;
});

let n = 0;
function freshHandlers(emitEvent: (topic: string, payload?: unknown) => number = () => 0) {
  const db = openStateDb(join(tmpdir(), `chat-h-${process.pid}-${n++}.db`));
  return createChatHandlers({ db, emitEvent });
}

function snapshotChatTables(db: Database) {
  return {
    members: db.query("SELECT * FROM chat_members ORDER BY room, handle;").all(),
    messages: db.query("SELECT * FROM chat_messages ORDER BY id;").all(),
  };
}

test("chat:join returns the resolved handle and member count", async () => {
  const h = freshHandlers();
  const res = await h["chat:join"]({ room: "build", handle: "a" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data).toMatchObject({ handle: "a", memberCount: 1 });
});

test("chat:join rejects an invalid handle with a reason rather than normalizing it", async () => {
  const h = freshHandlers();
  const res = await h["chat:join"]({ room: "build", handle: "Has@Sigil" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("handle");
});

test("chat:post returns the recipients and emits only the room's msg event", async () => {
  const emitted: string[] = [];
  const h = freshHandlers((topic) => { emitted.push(topic); return 0; });
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  const res = await h["chat:post"]({ room: "r", handle: "a", body: "@b hi" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data).toMatchObject({ recipients: ["b"] });
  expect(emitted).toEqual(["chat/r/msg"]);
});

test("chat:post rejects an invalid mentions element with a reason rather than storing it", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "a" });
  const res = await h["chat:post"]({ room: "r", handle: "a", body: "hi", mentions: ["b:c"] });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("handle");
});

test("the read-only handlers mutate nothing", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  await h["chat:post"]({ room: "r", handle: "a", body: "@b hello" });
  const before = snapshotChatTables(h.db);
  await h["chat:rooms"]({ handle: "b" });
  await h["chat:who"]({ room: "r" });
  await h["chat:messages"]({ room: "r", limit: 20 });
  expect(snapshotChatTables(h.db)).toEqual(before);
});

beforeEach(() => {
  drainNotifications();
  // Pin the mentioned human handle rather than depending on the ambient
  // setting (default "matt"). "matt" is the default, so setting it is
  // leak-safe: any test file bun runs next in this process sees the same
  // value it would have resolved anyway.
  setSetting("chat.humanHandle", "matt", "user");
});

test("notifies on a mention even when the human has never joined the room", async () => {
  // The common case, not an edge: agents create rooms via join-creates and
  // Matt is not a member until he posts. Gating this on recipientsFor -- which
  // reads chat_members and can only return members -- means the desk never
  // rings for the very question the skill tells agents to ask him.
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt ok to force-release?" });
  const notifications = peekNotifications();
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({ title: "#r" });
});

test("the mention notification links to the message in the viewer when chat.viewerUrl is set", async () => {
  setSetting("chat.viewerUrl", "https://chat.example/", "user");
  try {
    const h = freshHandlers();
    await h["chat:join"]({ room: "r", handle: "agent" });
    const posted = await h["chat:post"]({ room: "r", handle: "agent", body: "@matt look" });
    if (!posted.ok) throw new Error(posted.error);
    expect(peekNotifications()[0]).toMatchObject({ url: `https://chat.example/r/r#m-${posted.data.id}` });
  } finally {
    setSetting("chat.viewerUrl", "", "user");
  }
});

test("the mention notification carries no url when chat.viewerUrl is unset", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt look" });
  expect(peekNotifications()[0]?.url).toBeUndefined();
});

test("notifies even when the human is a member with wake_on none", async () => {
  // Plausible for a human who does not want a waiter armed; his wake setting
  // must not silently disable his desk notifications.
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:join"]({ room: "r", handle: "matt", wakeOn: "none" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt still there?" });
  expect(peekNotifications()).toHaveLength(1);
});

test("does not notify on a mention of anyone else", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@nobody hello" });
  expect(peekNotifications()).toHaveLength(0);
});

test("chat_mention disabled in prefs suppresses the notification entirely", async () => {
  const saved = loadNotificationPrefs();
  try {
    saveNotificationPrefs({ ...saved, chat_mention: false });
    const h = freshHandlers();
    await h["chat:join"]({ room: "r", handle: "agent" });
    await h["chat:post"]({ room: "r", handle: "agent", body: "@matt hi" });
    expect(peekNotifications()).toHaveLength(0);
  } finally {
    saveNotificationPrefs(saved);
  }
});

// ─── Presence ─────────────────────────────────────────────────────────────

test("sign-in assigns and a second same-base session gets the suffix", async () => {
  const h = freshHandlers();
  const first = await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" });
  if (!first.ok) throw new Error("unreachable");
  expect(first.data).toMatchObject({ handle: "x" });
  const second = await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "x" });
  if (!second.ok) throw new Error("unreachable");
  expect(second.data).toMatchObject({ handle: "x-2" });
});

test("sign-in without a baseHandle draws a first name from the pool", async () => {
  const h = freshHandlers();
  const res = await h["chat:sign-in"]({ sessionId: "s1" });
  if (!res.ok) throw new Error("unreachable");
  expect(AGENT_NAMES).toContain(res.data.baseHandle);
  expect(res.data.handle).toBe(res.data.baseHandle);
});

test("renderWelcome carries the handle, room list, the automatic-delivery sentence, the two-line reply contract, the read/skill pointers, and catch-up capped at 10 lines per room", () => {
  const manyLines = Array.from({ length: 12 }, (_, i) => `agent: msg ${i}`);
  const text = renderWelcome("kai", ["build", "general"], [
    { room: "build", lines: manyLines },
    { room: "general", lines: [] },
  ]);
  expect(text).toContain("kai");
  expect(text).toContain("#build");
  expect(text).toContain("#general");
  expect(text).toContain("Messages will arrive in your context automatically; you never need to poll or arm anything.");
  expect(text).toContain('Reply in a room with: rt chat post <room> "..."');
  expect(text).toContain('Reply privately with: rt chat dm <handle> "..."');
  expect(text).toContain("rt chat read shows a room's history.");
  expect(text).toContain("rt:chat skill");
  expect(text.split("\n").filter((l) => l.includes("msg "))).toHaveLength(10);
});

function paneSnapshotHandler(paneId: string, sessionId: string, cwd?: string): FakeHerdrHandler {
  return (method) => {
    if (method !== "session.snapshot") return new HerdrFakeError("invalid_request", method);
    return {
      snapshot: {
        workspaces: [],
        panes: [
          {
            pane_id: paneId,
            workspace_id: "w1",
            tab_id: "w1:t1",
            agent: "claude",
            agent_status: "idle",
            cwd,
            agent_session: { source: "claude", agent: "claude", kind: "id", value: sessionId },
          },
        ],
      },
    };
  };
}

test("chat:sign-in viaPane resolves the pane's Claude session via herdr, signs it in under that session id, and sends a welcome frame", async () => {
  const uuid = "11111111-1111-1111-1111-111111111111";
  const { sock: herdrSock, stop } = fakeHerdr(paneSnapshotHandler("w1:p1", uuid));
  stops.push(stop);

  const inboxSock = fakeSocketPath();
  const calls: Array<[string, string]> = [];
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === uuid ? { pid: process.pid, socketPath: inboxSock, status: "idle" } : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };

  const db = openStateDb(join(tmpdir(), `chat-viapane-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr, inboxDeps });

  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.sessionId).toBe(uuid);
  expect(res.data.room).toBeNull(); // no cwd on this pane: nothing to derive a room from

  const presence = db.query("SELECT session_id, handle FROM chat_presence WHERE session_id = ?").get(uuid) as
    | { session_id: string; handle: string }
    | null;
  expect(presence).toMatchObject({ session_id: uuid, handle: res.data.handle });

  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe(inboxSock);
  expect(calls[0]![1]).toContain(res.data.handle);
  expect(calls[0]![1]).toContain('Reply in a room with: rt chat post <room> "..."');
});

test("chat:sign-in viaPane joins the SAME room the CLI's own codec would derive for that repo (parity fix), independent of the repos.json index label", async () => {
  const uuid = "33333333-3333-3333-3333-333333333333";
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-viapane-repo-")));
  initRepo(repoDir);
  const { sock: herdrSock, stop } = fakeHerdr(paneSnapshotHandler("w1:p1", uuid, repoDir));
  stops.push(stop);

  const db = openStateDb(join(tmpdir(), `chat-viapane-repo-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  // The repos.json index label is display-only (presence.repo) now: it must
  // NOT double as the room source, so this fixture deliberately names
  // something OTHER than what the git identity slugifies to -- if the room
  // ever came from this label again, the parity assertion below would catch it.
  const repoIndex = () => ({ "remote:gitlab.com%2Facme%2FRepo-Tools": repoDir });
  // Stubs ONLY the branch read (deterministic output, no checked-out feature
  // branch needed); the room derivation's own git calls (rev-parse
  // --show-toplevel, and everything deriveRepoIdentity itself spawns) reach
  // the real repo initRepo() created, through the real runCapture.
  const exec: typeof runCapture = async (argv, opts) =>
    argv.includes("--abbrev-ref") ? { stdout: "feat/pane-sign-in\n", stderr: "", exitCode: 0 } : runCapture(argv, opts);
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr, repoIndex, exec });

  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true, baseHandle: "kai" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const expectedRoom = deriveRoomForCwd(repoDir);
  expect(expectedRoom).not.toBeNull();
  expect(res.data.room).toBe(expectedRoom);
  expect(res.data.room).not.toBe("repo-tools"); // the old, now-wrong, index-label-derived room

  const presence = db.query("SELECT repo, branch FROM chat_presence WHERE session_id = ?").get(uuid) as
    | { repo: string; branch: string }
    | null;
  expect(presence).toMatchObject({ repo: "Repo-Tools", branch: "feat/pane-sign-in" }); // display label: unaffected

  const who = await h["chat:who"]({ room: expectedRoom! });
  if (!who.ok) throw new Error("unreachable");
  expect(who.data.members.map((m) => m.handle)).toEqual(["kai"]);
});

test("chat:sign-in viaPane degrades to no room, without failing sign-in, when room derivation throws (e.g. a read-only HOME)", async () => {
  const uuid = "10101010-1010-1010-1010-101010101010";
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-viapane-throws-")));
  initRepo(repoDir);
  const { sock: herdrSock, stop } = fakeHerdr(paneSnapshotHandler("w1:p1", uuid, repoDir));
  stops.push(stop);

  const db = openStateDb(join(tmpdir(), `chat-viapane-throws-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  // Only the room-derivation call (rev-parse --show-toplevel) throws; the
  // branch read must keep working normally, same as `runCapture`'s real
  // "never throws" contract everywhere except the one seam under test.
  const exec: typeof runCapture = async (argv) => {
    if (argv.includes("--abbrev-ref")) return { stdout: "main\n", stderr: "", exitCode: 0 };
    throw new Error("EACCES: permission denied, mkdir '/read-only-home/.mattstack'");
  };
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr, exec });

  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true, baseHandle: "kai" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.room).toBeNull();

  const rooms = await h["chat:rooms"]({ handle: "kai" });
  if (!rooms.ok) throw new Error("unreachable");
  expect(rooms.data.rooms).toEqual([]);
});

test("chat:sign-in viaPane with a cwd that isn't a git work tree at all joins nothing", async () => {
  const uuid = "44444444-4444-4444-4444-444444444444";
  const strayDir = mkdtempSync(join(tmpdir(), "chat-viapane-stray-"));
  const { sock: herdrSock, stop } = fakeHerdr(paneSnapshotHandler("w1:p1", uuid, strayDir));
  stops.push(stop);

  const db = openStateDb(join(tmpdir(), `chat-viapane-stray-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr });

  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true, baseHandle: "kai" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.room).toBeNull();

  const rooms = await h["chat:rooms"]({ handle: "kai" });
  if (!rooms.ok) throw new Error("unreachable");
  expect(rooms.data.rooms).toEqual([]);
});

test("chat:sign-in viaPane --no-room skips the join even with a real repo cwd", async () => {
  const uuid = "77777777-7777-7777-7777-777777777777";
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-viapane-noroom-")));
  initRepo(repoDir);
  const { sock: herdrSock, stop } = fakeHerdr(paneSnapshotHandler("w1:p1", uuid, repoDir));
  stops.push(stop);
  const db = openStateDb(join(tmpdir(), `chat-viapane-noroom-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr });

  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true, baseHandle: "kai", noRoom: true });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.room).toBeNull();
  const rooms = await h["chat:rooms"]({ handle: "kai" });
  if (!rooms.ok) throw new Error("unreachable");
  expect(rooms.data.rooms).toEqual([]);
});

test("chat:sign-in viaPane --room overrides the derived room with the explicit one", async () => {
  const uuid = "88888888-8888-8888-8888-888888888888";
  const repoDir = realpathSync(mkdtempSync(join(tmpdir(), "chat-viapane-explicit-")));
  initRepo(repoDir);
  const { sock: herdrSock, stop } = fakeHerdr(paneSnapshotHandler("w1:p1", uuid, repoDir));
  stops.push(stop);
  const db = openStateDb(join(tmpdir(), `chat-viapane-explicit-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr });

  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true, baseHandle: "kai", room: "warroom" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.room).toBe("warroom");
  const who = await h["chat:who"]({ room: "warroom" });
  if (!who.ok) throw new Error("unreachable");
  expect(who.data.members.map((m) => m.handle)).toEqual(["kai"]);
});

test("chat:sign-in viaPane rejects an invalid explicit --room with a reason", async () => {
  const uuid = "99999999-9999-9999-9999-999999999999";
  const { sock: herdrSock, stop } = fakeHerdr(paneSnapshotHandler("w1:p1", uuid));
  stops.push(stop);
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  const h = createChatHandlers({ db: openStateDb(join(tmpdir(), `chat-viapane-badroom-${process.pid}-${n++}.db`)), emitEvent: () => 0, herdr });
  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true, room: "Bad Room" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("room");
});

test("chat:sign-in viaPane refuses a pane herdr has no Claude session for, distinctly from herdr being unreachable", async () => {
  const { sock: herdrSock, stop } = fakeHerdr(() => ({ snapshot: { workspaces: [], panes: [] } }));
  stops.push(stop);
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: herdrSock });
  const h = createChatHandlers({ db: openStateDb(join(tmpdir(), `chat-viapane-miss-${process.pid}-${n++}.db`)), emitEvent: () => 0, herdr });
  const res = await h["chat:sign-in"]({ pane: "w1:p1", viaPane: true });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("w1:p1");

  const unreachableHerdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: join(tmpdir(), "absent-herdr.sock") });
  const h2 = createChatHandlers({ db: openStateDb(join(tmpdir(), `chat-viapane-down-${process.pid}-${n++}.db`)), emitEvent: () => 0, herdr: unreachableHerdr });
  const res2 = await h2["chat:sign-in"]({ pane: "w1:p1", viaPane: true });
  expect(res2.ok).toBe(false);
  if (res2.ok) throw new Error("unreachable");
  expect(res2.error).toContain("herdr unavailable");
  expect(res2.error).not.toBe(res.error);
});

test("chat:sign-in draws baseHandle from the inbox registry's own name when none is given explicitly", async () => {
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "s1" ? { pid: process.pid, socketPath: fakeSocketPath(), status: "idle", name: "kai" } : null),
    deliver: async () => ({ ok: true }),
  };
  const db = openStateDb(join(tmpdir(), `chat-h-reg-${process.pid}-${n++}.db`));
  const h = createChatHandlers({ db, emitEvent: () => 0, inboxDeps });
  const res = await h["chat:sign-in"]({ sessionId: "s1" });
  if (!res.ok) throw new Error("unreachable");
  expect(res.data).toMatchObject({ handle: "kai", baseHandle: "kai" });
});

test("sign-in rejects an invalid baseHandle with a reason rather than normalizing it", async () => {
  const h = freshHandlers();
  const res = await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "remote:host%2Fx" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("handle");
});

test("chat:sign-out is a no-op success for a session that never signed in", async () => {
  const h = freshHandlers();
  const res = await h["chat:sign-out"]({ sessionId: "never-signed-in" });
  expect(res.ok).toBe(true);
});

test("chat:sign-out is a no-op success once the session's presence row was reclaimed", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" });
  h.db.run("UPDATE chat_presence SET last_seen_at = last_seen_at - 7200000");
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "x" });
  const res = await h["chat:sign-out"]({ sessionId: "s1" });
  expect(res.ok).toBe(true);
});

test("chat:away sets status_text and chat:back clears it, both refusing an unsigned session", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" });
  const away = await h["chat:away"]({ sessionId: "s1", text: "lunch" });
  expect(away.ok).toBe(true);
  const buddies = await h["chat:buddies"]({});
  if (!buddies.ok) throw new Error("unreachable");
  expect(buddies.data.buddies[0]).toMatchObject({ statusText: "lunch" });

  const back = await h["chat:back"]({ sessionId: "s1" });
  expect(back.ok).toBe(true);

  const awayRefused = await h["chat:away"]({ sessionId: "never-signed-in", text: "x" });
  expect(awayRefused.ok).toBe(false);
  if (awayRefused.ok) throw new Error("unreachable");
  expect(awayRefused.error).toContain("handle reclaimed");

  const backRefused = await h["chat:back"]({ sessionId: "never-signed-in" });
  expect(backRefused.ok).toBe(false);
  if (backRefused.ok) throw new Error("unreachable");
  expect(backRefused.error).toContain("handle reclaimed");
});

test("a signed-out session refuses away/back without the reclaimed wording", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" });
  await h["chat:sign-out"]({ sessionId: "s1" });

  const away = await h["chat:away"]({ sessionId: "s1", text: "x" });
  expect(away.ok).toBe(false);
  if (away.ok) throw new Error("unreachable");
  expect(away.error).not.toMatch(/handle reclaimed/);

  const back = await h["chat:back"]({ sessionId: "s1" });
  expect(back.ok).toBe(false);
  if (back.ok) throw new Error("unreachable");
  expect(back.error).not.toMatch(/handle reclaimed/);
});

test("chat:buddies reports the roster with a status per row, offline with no resolvable registry binding", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" });
  const res = await h["chat:buddies"]({});
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.buddies).toHaveLength(1);
  // No fake registryDeps here: the default resolver finds nothing for this
  // test session id, which now reads offline (unresolvable), not idle.
  expect(res.data.buddies[0]).toMatchObject({ handle: "x", status: "offline" });
});

test("chat:buddies and chat:who read the registry mirror through the injected registryDeps seam", async () => {
  const db = openStateDb(join(tmpdir(), `chat-h-registry-${process.pid}-${n++}.db`));
  const busyBinding = { pid: process.pid, socketPath: fakeSocketPath(), status: "busy" as const };
  const registryDeps = { resolve: () => busyBinding, alive: () => true, resolveAll: () => new Map([["s1", busyBinding]]) };
  const h = createChatHandlers({ db, emitEvent: () => 0, registryDeps });

  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "x" });
  const buddies = await h["chat:buddies"]({});
  if (!buddies.ok) throw new Error("unreachable");
  expect(buddies.data.buddies[0]).toMatchObject({ handle: "x", status: "live" });

  await h["chat:join"]({ room: "r", handle: "x" });
  const who = await h["chat:who"]({ room: "r" });
  if (!who.ok) throw new Error("unreachable");
  expect(who.data.members.find((m) => m.handle === "x")?.status).toBe("live");
});

test("chat:dm creates once, posts with the recipient in mentions, and reports recipients", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "b" });
  const res = await h["chat:dm"]({ from: "a", to: "b", body: "ping" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.recipients).toEqual(["b"]);

  const again = await h["chat:dm"]({ from: "a", to: "b", body: "again" });
  if (!again.ok) throw new Error("unreachable");
  expect(again.data.room).toBe(res.data.room);
});

test("chat:dm rejects an invalid recipient handle with a reason rather than normalizing it", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  const res = await h["chat:dm"]({ from: "a", to: "a:b", body: "hi" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("handle");
});

test("chat:dm rejects an invalid sender handle with a reason rather than routing it through unenforced", async () => {
  const h = freshHandlers();
  const res = await h["chat:dm"]({ from: "a:b", to: "c", body: "hi" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("handle");
});

test("chat:dm refuses a reclaimed sender", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  h.db.run("UPDATE chat_presence SET last_seen_at = last_seen_at - 7200000");
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "a" });
  const res = await h["chat:dm"]({ from: "a", to: "b", body: "ping", sessionId: "s1" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("handle reclaimed");
});

test("chat:dm refuses when chat.humanHandle is empty, naming the setting rather than inserting a blank silent member", async () => {
  const h = freshHandlers();
  setSetting("chat.humanHandle", "", "user");
  try {
    await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
    const res = await h["chat:dm"]({ from: "a", to: "b", body: "hi" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("chat.humanHandle");
  } finally {
    setSetting("chat.humanHandle", "matt", "user");
  }
});

test("dm posts to the human notify when the recipient is matt, titled by sender not the hashed room id", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "agent" });
  await h["chat:dm"]({ from: "agent", to: "matt", body: "ping" });
  const notifications = peekNotifications();
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({ title: "DM from agent" });
});

test("chat:rooms marks a dm and chat:who carries presence statuses", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "b" });
  const dm = await h["chat:dm"]({ from: "a", to: "b", body: "hi" });
  if (!dm.ok) throw new Error("unreachable");

  const rooms = await h["chat:rooms"]({ handle: "a" });
  if (!rooms.ok) throw new Error("unreachable");
  const dmRoom = rooms.data.rooms.find((r) => r.room === dm.data.room);
  expect(dmRoom).toMatchObject({ kind: "dm", participants: { a: "a", b: "b" } });

  const who = await h["chat:who"]({ room: dm.data.room });
  if (!who.ok) throw new Error("unreachable");
  const memberA = who.data.members.find((m) => m.handle === "a");
  // No fake registryDeps: the default resolver finds nothing for this test
  // session id, which reads offline (unresolvable), not idle.
  expect(memberA?.status).toBe("offline");
});

test("chat:rooms carries a room's stamped default wake mode, and leaves it undefined when never stamped", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "loud", handle: "a", wakeOn: "all" });
  await h["chat:join"]({ room: "quiet", handle: "b" });

  const rooms = await h["chat:rooms"]({ handle: "a" });
  if (!rooms.ok) throw new Error("unreachable");
  expect(rooms.data.rooms.find((r) => r.room === "loud")).toMatchObject({ defaultWake: "all" });

  const rooms2 = await h["chat:rooms"]({ handle: "b" });
  if (!rooms2.ok) throw new Error("unreachable");
  expect(rooms2.data.rooms.find((r) => r.room === "quiet")?.defaultWake).toBeUndefined();
});

test("chat:who on an agent-agent dm room excludes the silent human row", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "b" });
  const dm = await h["chat:dm"]({ from: "a", to: "b", body: "hi" });
  if (!dm.ok) throw new Error("unreachable");
  const who = await h["chat:who"]({ room: dm.data.room });
  if (!who.ok) throw new Error("unreachable");
  expect(who.data.members.map((m) => m.handle).sort()).toEqual(["a", "b"]);
});

test("chat:who on a human dm room still lists the human as a participant", async () => {
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "agent" });
  const dm = await h["chat:dm"]({ from: "agent", to: "matt", body: "hi" });
  if (!dm.ok) throw new Error("unreachable");
  const who = await h["chat:who"]({ room: dm.data.room });
  if (!who.ok) throw new Error("unreachable");
  expect(who.data.members.map((m) => m.handle).sort()).toEqual(["agent", "matt"]);
});

test("chat:who reports offline for a member with no presence row (the unsigned plan-1 path)", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "a" });
  const who = await h["chat:who"]({ room: "r" });
  if (!who.ok) throw new Error("unreachable");
  const memberA = who.data.members.find((m) => m.handle === "a");
  expect(memberA?.status).toBe("offline"); // status is a presence-only concept now
});

// ─── chat:invite ──────────────────────────────────────────────────────────

function inviteHarness(handler: FakeHerdrHandler) {
  const { sock, seen, stop } = fakeHerdr(handler);
  stops.push(stop);
  const db = openStateDb(join(tmpdir(), `chat-inv-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: sock });
  return { h: createChatHandlers({ db, emitEvent: () => 0, herdr }), seen };
}

const agent = (status: string, kind = "claude") => ({ type: "agent_info", agent: { pane_id: "w1:p1", terminal_id: "t", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent: kind, agent_status: status, revision: 1 } });

test("inviteText is one line: the slash command, then the attributed note with newlines collapsed", () => {
  expect(inviteText("build", "matt")).toBe("/chat:join build");
  expect(inviteText("build", "fred", "take the\nserver half\n")).toBe("/chat:join build note from fred: take the server half");
  // A lone CR (no LF) and a CRLF must collapse too, or the injected command spans lines.
  expect(inviteText("build", "fred", "take the\rserver half\r")).toBe("/chat:join build note from fred: take the server half");
  expect(inviteText("build", "fred", "a\r\nb")).toBe("/chat:join build note from fred: a b");
});

test("chat:invite prompts an idle pane and reports accepted when it reaches working", async () => {
  const { h, seen } = inviteHarness((method, params) => {
    if (method === "agent.get") return agent("idle");
    if (method === "agent.prompt") return { type: "agent_prompted", agent: { ...agent("working").agent, text: params.text } };
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt", note: "you own vite" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "accepted" } });
  const prompt = seen.find((s) => s.method === "agent.prompt")!;
  expect(prompt.params).toEqual({ target: "w1:p1", text: "/chat:join build note from matt: you own vite", wait: { until: ["working"], timeout_ms: 5000 } });
});

test("chat:invite queues into a working pane without waiting", async () => {
  const { h, seen } = inviteHarness((method) => {
    if (method === "agent.get") return agent("working");
    if (method === "agent.prompt") return { type: "agent_prompted", agent: agent("working").agent };
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "queued" } });
  expect(seen.find((s) => s.method === "agent.prompt")!.params).toEqual({ target: "w1:p1", text: "/chat:join build" });
});

test("chat:invite refuses a blocked pane without sending anything", async () => {
  const { h, seen } = inviteHarness((method) => (method === "agent.get" ? agent("blocked") : new HerdrFakeError("invalid_request", method)));
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "at a prompt" } });
  expect(seen.map((s) => s.method)).toEqual(["agent.get"]);
});

test("chat:invite nudges Enter once on a stalled prompt, then reports accepted or queued honestly", async () => {
  let prompts = 0;
  const { h, seen } = inviteHarness((method) => {
    if (method === "agent.get") return agent("idle");
    // herdr answers a stall inside the 5s effect window with `timeout`; `agent_prompt_stalled` needs a longer budget. The handler accepts both.
    if (method === "agent.prompt") { prompts++; return new HerdrFakeError("timeout", "timed out waiting for agent status"); }
    if (method === "pane.send_keys") return { type: "ok" };
    if (method === "agent.wait") return new HerdrFakeError("timeout", "timed out waiting for agent status");
    return new HerdrFakeError("invalid_request", method);
  });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "queued" } });
  expect(prompts).toBe(1);
  expect(seen.filter((s) => s.method === "pane.send_keys")).toHaveLength(1);
});

test("chat:invite refuses a pane that is not a claude pane, the caller's own pane, and a bad room", async () => {
  const { h } = inviteHarness((method) => (method === "agent.get" ? new HerdrFakeError("agent_not_found", "agent target w1:p1 not found") : new HerdrFakeError("invalid_request", method)));
  expect(await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" })).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "not a claude pane" } });
  expect(await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt", callerPane: "w1:p1" })).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "that is this pane" } });
  const codex = inviteHarness((method) => (method === "agent.get" ? agent("idle", "codex") : new HerdrFakeError("invalid_request", method)));
  expect(await codex.h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" })).toEqual({ ok: true, data: { paneId: "w1:p1", delivered: "refused", reason: "not a claude pane" } });
  const bad = await h["chat:invite"]({ paneId: "w1:p1", room: "Bad Room", from: "matt" });
  expect(bad.ok).toBe(false);
});

test("chat:invite is herdr unavailable when the socket is missing", async () => {
  const db = openStateDb(join(tmpdir(), `chat-inv-${process.pid}-${n++}.db`));
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: join(tmpdir(), "absent-herdr.sock") });
  const h = createChatHandlers({ db, emitEvent: () => 0, herdr });
  const res = await h["chat:invite"]({ paneId: "w1:p1", room: "build", from: "matt" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.startsWith("herdr unavailable")).toBe(true);
});

test("chat:archive hides the room from chat:rooms until includeArchived asks, and reopen restores it", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "build", handle: "a" });
  const res = await h["chat:archive"]({ room: "build", handle: "a", archived: true });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data.room).toBe("build");
  expect(typeof res.data.archivedAt).toBe("number");

  const hidden = await h["chat:rooms"]({ handle: "a" });
  if (!hidden.ok) throw new Error("unreachable");
  expect(hidden.data.rooms).toEqual([]);

  const shown = await h["chat:rooms"]({ handle: "a", includeArchived: true });
  if (!shown.ok) throw new Error("unreachable");
  expect(shown.data.rooms).toHaveLength(1);
  expect(shown.data.rooms[0]).toMatchObject({ room: "build", archivedAt: res.data.archivedAt });

  const reopened = await h["chat:archive"]({ room: "build", handle: "a", archived: false });
  if (!reopened.ok) throw new Error("unreachable");
  expect(reopened.data).toEqual({ room: "build", archivedAt: null });
  const back = await h["chat:rooms"]({ handle: "a" });
  if (!back.ok) throw new Error("unreachable");
  expect(back.data.rooms.map((r) => r.room)).toEqual(["build"]);
});

test("chat:archive refuses an unknown room and an invalid name with a reason", async () => {
  const h = freshHandlers();
  const missing = await h["chat:archive"]({ room: "nope", handle: "a", archived: true });
  expect(missing.ok).toBe(false);
  if (missing.ok) throw new Error("unreachable");
  expect(missing.error).toContain("no such room");
  const bad = await h["chat:archive"]({ room: "Has@Sigil", handle: "a", archived: true });
  expect(bad.ok).toBe(false);
  if (bad.ok) throw new Error("unreachable");
  expect(bad.error).toContain("room");
});

test("chat:dm-open creates the pair's room without posting, then reuses it", async () => {
  const emitted: string[] = [];
  const h = freshHandlers((topic) => { emitted.push(topic); return 0; });
  const first = await h["chat:dm-open"]({ from: "matt", to: "a" });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  expect(first.data.created).toBe(true);
  expect(first.data.room).toMatch(/^dm-/);
  expect(emitted).toEqual([]);

  const again = await h["chat:dm-open"]({ from: "matt", to: "a" });
  if (!again.ok) throw new Error("unreachable");
  expect(again.data).toEqual({ room: first.data.room, created: false });

  const messages = await h["chat:messages"]({ room: first.data.room });
  if (!messages.ok) throw new Error("unreachable");
  expect(messages.data.messages).toEqual([]);
  const who = await h["chat:who"]({ room: first.data.room });
  if (!who.ok) throw new Error("unreachable");
  expect(who.data.members.map((m) => m.handle).sort()).toEqual(["a", "matt"]);
});

test("chat:dm-open refuses a self DM, an invalid handle, and an empty humanHandle setting", async () => {
  const h = freshHandlers();
  const self = await h["chat:dm-open"]({ from: "matt", to: "matt" });
  expect(self.ok).toBe(false);
  if (self.ok) throw new Error("unreachable");
  expect(self.error).toMatch(/your own/i);

  const bad = await h["chat:dm-open"]({ from: "matt", to: "a:b" });
  expect(bad.ok).toBe(false);

  setSetting("chat.humanHandle", "", "user");
  try {
    const empty = await h["chat:dm-open"]({ from: "matt", to: "a" });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error("unreachable");
    expect(empty.error).toContain("chat.humanHandle");
  } finally {
    setSetting("chat.humanHandle", "matt", "user");
  }
});

test("chat:dm-open refuses a reclaimed sender the same way chat:dm does", async () => {
  // Same setup as `chat:dm refuses a reclaimed sender`: the
  // first session goes stale, a second session claims the handle, and the
  // stale session's own id no longer owns it.
  const h = freshHandlers();
  await h["chat:sign-in"]({ sessionId: "s1", baseHandle: "a" });
  h.db.run("UPDATE chat_presence SET last_seen_at = last_seen_at - 7200000");
  await h["chat:sign-in"]({ sessionId: "s2", baseHandle: "a" });
  const res = await h["chat:dm-open"]({ from: "a", to: "b", sessionId: "s1" });
  expect(res.ok).toBe(false);
});
