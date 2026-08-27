import { describe, expect, test, afterEach, spyOn } from "bun:test";
import { readProjectMRs, readDiscussions, readMrsByBranch, listRuns, abandonRun, readBranchCache, chatInvite, paneDirectories, paneList, panePeek, paneSpawn, chatArchive, chatDmOpen, chatRooms } from "../src/client.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

describe("readProjectMRs", () => {
  test("omits maxAgeMs when not given, passes it when given (incl. 0)", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "project-mrs:read": { ok: true, data: { mrs: {}, listSyncedAt: 0, source: "poll", syncedAt: 0 } },
    });
    stops.push(stop);
    await readProjectMRs("acme-dev", undefined, { sockPath: sock });
    await readProjectMRs("acme-dev", 0, { sockPath: sock });
    expect(seen[0]!.payload).toEqual({ repoName: "acme-dev" });
    expect(seen[1]!.payload).toEqual({ repoName: "acme-dev", maxAgeMs: 0 });
  });

  test("demand rides the read payload when given", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "project-mrs:read": { ok: true, data: { mrs: {}, listSyncedAt: 5, source: "poll", syncedAt: 5 } },
    });
    stops.push(stop);
    await readProjectMRs("x", 0, { sockPath: sock }, { client: "mr-board:1", authors: ["a"], declaredAt: 7 });
    expect(seen).toEqual([{ cmd: "project-mrs:read",
      payload: { repoName: "x", maxAgeMs: 0, demand: { client: "mr-board:1", authors: ["a"], declaredAt: 7 } } }]);
  });

  test("omitted demand leaves the payload clean", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "project-mrs:read": { ok: true, data: { mrs: {}, listSyncedAt: 5, source: "poll", syncedAt: 5 } },
    });
    stops.push(stop);
    await readProjectMRs("x", undefined, { sockPath: sock });
    expect(seen).toEqual([{ cmd: "project-mrs:read", payload: { repoName: "x" } }]);
  });
});

describe("readDiscussions", () => {
  test("sends repoName + iid", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "discussions:read": { ok: true, data: { discussions: [], fetchedAt: 1, stale: false } },
    });
    stops.push(stop);
    const res = await readDiscussions("acme-dev", 42, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen[0]!.payload).toEqual({ repoName: "acme-dev", iid: 42 });
  });
});

describe("readMrsByBranch", () => {
  test("sends repoName + branches", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "mr:by-branch": { ok: true, data: { byBranch: {}, syncedAt: 1 } },
    });
    stops.push(stop);
    const res = await readMrsByBranch("acme-dev", ["feat-a", "feat-b"], { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen[0]!.payload).toEqual({ repoName: "acme-dev", branches: ["feat-a", "feat-b"] });
  });
});

describe("readBranchCache", () => {
  test("sends the branches list on cache:read", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "cache:read": { ok: true, data: { "feat-a": { ticket: null, mr: null, fetchedAt: 1 } } },
    });
    stops.push(stop);
    const res = await readBranchCache(["feat-a", "feat-b"], { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen[0]).toEqual({ cmd: "cache:read", payload: { branches: ["feat-a", "feat-b"] } });
  });

  test("maps a populated entry using the real wire field names (camelCase webUrl, nested pipeline.status)", async () => {
    const { sock, stop } = fakeDaemon({
      "cache:read": {
        ok: true,
        data: {
          "feat-a": {
            ticket: { identifier: "ACME-1", title: "Ship the thing", url: "https://linear.app/acme/issue/ACME-1" },
            mr: {
              iid: 42,
              webUrl: "https://gitlab.example.com/acme/repo/-/merge_requests/42",
              state: "opened",
              pipeline: { status: "success" },
            },
            fetchedAt: 1700000000000,
          },
        },
      },
    });
    stops.push(stop);
    const res = await readBranchCache(["feat-a"], { sockPath: sock });
    expect(res.ok).toBe(true);
    const entry = res.data!["feat-a"]!;
    expect(entry.ticket).toEqual({ identifier: "ACME-1", title: "Ship the thing", url: "https://linear.app/acme/issue/ACME-1" });
    expect(entry.mr!.iid).toBe(42);
    expect(entry.mr!.webUrl).toBe("https://gitlab.example.com/acme/repo/-/merge_requests/42");
    expect(entry.mr!.state).toBe("opened");
    expect(entry.mr!.pipeline).toEqual({ status: "success" });
    expect(entry.fetchedAt).toBe(1700000000000);
  });
});

describe("run verbs", () => {
  test("listRuns omits repo when not given, passes it when given", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "runs:list": { ok: true, data: { runs: [] } },
    });
    stops.push(stop);
    await listRuns(undefined, { sockPath: sock });
    await listRuns("repo-tools", { sockPath: sock });
    expect(seen[0]!.payload).toEqual({});
    expect(seen[1]!.payload).toEqual({ repo: "repo-tools" });
  });

  test("abandonRun sends runId, and reason only when given", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "runs:abandon": { ok: true, data: { ok: true } },
    });
    stops.push(stop);
    await abandonRun("run-1", "repo-tools", "wedged overnight", { sockPath: sock });
    await abandonRun("run-2", undefined, undefined, { sockPath: sock });
    expect(seen[0]).toEqual({
      cmd: "runs:abandon",
      payload: { runId: "run-1", repo: "repo-tools", reason: "wedged overnight" },
    });
    expect(seen[1]!.payload).toEqual({ runId: "run-2" });
  });
});

describe("pane wrappers", () => {
  test("paneList sends an empty payload; panePeek and paneDirectories omit undefined fields", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "pane:list": { ok: true, data: { panes: [] } },
      "pane:peek": { ok: true, data: { paneId: "w1:p1", lines: [] } },
      "pane:directories": { ok: true, data: { directories: [] } },
    });
    stops.push(stop);
    await paneList({ sockPath: sock });
    await panePeek({ paneId: "w1:p1" }, { sockPath: sock });
    await paneDirectories({}, { sockPath: sock });
    expect(seen.map((s) => [s.cmd, s.payload])).toEqual([
      ["pane:list", {}],
      ["pane:peek", { paneId: "w1:p1" }],
      ["pane:directories", {}],
    ]);
  });

  test("paneSpawn and chatInvite outlive rt-client's 15s default", async () => {
    const { sock, stop } = fakeDaemon({});
    stops.push(stop);
    // fakeDaemon answers instantly; the assertion is on the timeout the wrapper hands rtCommand,
    // captured through the AbortSignal it builds. Spy on AbortSignal.timeout.
    const spy = spyOn(AbortSignal, "timeout");
    await paneSpawn({ cwd: "/x" }, { sockPath: sock });
    await chatInvite({ paneId: "w1:p1", room: "build", from: "matt" }, { sockPath: sock });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([90_000, 30_000]);
    spy.mockRestore();
  });
});

describe("chat archive and dm-open", () => {
  test("chatArchive sends room, handle and archived verbatim", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "chat:archive": { ok: true, data: { room: "build", archivedAt: 5 } },
    });
    stops.push(stop);
    const res = await chatArchive({ room: "build", handle: "matt", archived: true }, { sockPath: sock });
    expect(res).toEqual({ ok: true, data: { room: "build", archivedAt: 5 } });
    expect(seen).toEqual([{ cmd: "chat:archive", payload: { room: "build", handle: "matt", archived: true } }]);
  });

  test("chatDmOpen omits sessionId when not given and passes it when given", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "chat:dm-open": { ok: true, data: { room: "dm-abc", created: true } },
    });
    stops.push(stop);
    await chatDmOpen({ from: "matt", to: "a" }, { sockPath: sock });
    await chatDmOpen({ from: "a", to: "b", sessionId: "s1" }, { sockPath: sock });
    expect(seen[0]!.payload).toEqual({ from: "matt", to: "a" });
    expect(seen[1]!.payload).toEqual({ from: "a", to: "b", sessionId: "s1" });
  });

  test("chatRooms sends includeArchived only when true", async () => {
    const { sock, seen, stop } = fakeDaemon({ "chat:rooms": { ok: true, data: { rooms: [] } } });
    stops.push(stop);
    await chatRooms({ handle: "matt" }, { sockPath: sock });
    await chatRooms({ handle: "matt", includeArchived: false }, { sockPath: sock });
    await chatRooms({ handle: "matt", includeArchived: true }, { sockPath: sock });
    expect(seen.map((s) => s.payload)).toEqual([
      { handle: "matt" },
      { handle: "matt" },
      { handle: "matt", includeArchived: true },
    ]);
  });
});
