import { describe, expect, test, afterEach } from "bun:test";
import { readProjectMRs, readDiscussions, readMrsByBranch, listRuns, abandonRun } from "../src/client.ts";
import { fakeDaemon } from "./fake-daemon.ts";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops) stop(); stops.length = 0; });

describe("readProjectMRs", () => {
  test("omits maxAgeMs when not given, passes it when given (incl. 0)", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "project-mrs:read": { ok: true, data: { mrs: {}, listSyncedAt: 0, source: "poll", syncedAt: 0 } },
    });
    stops.push(stop);
    await readProjectMRs("assured-dev", undefined, { sockPath: sock });
    await readProjectMRs("assured-dev", 0, { sockPath: sock });
    expect(seen[0]!.payload).toEqual({ repoName: "assured-dev" });
    expect(seen[1]!.payload).toEqual({ repoName: "assured-dev", maxAgeMs: 0 });
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
    const res = await readDiscussions("assured-dev", 42, { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen[0]!.payload).toEqual({ repoName: "assured-dev", iid: 42 });
  });
});

describe("readMrsByBranch", () => {
  test("sends repoName + branches", async () => {
    const { sock, seen, stop } = fakeDaemon({
      "mr:by-branch": { ok: true, data: { byBranch: {}, syncedAt: 1 } },
    });
    stops.push(stop);
    const res = await readMrsByBranch("assured-dev", ["feat-a", "feat-b"], { sockPath: sock });
    expect(res.ok).toBe(true);
    expect(seen[0]!.payload).toEqual({ repoName: "assured-dev", branches: ["feat-a", "feat-b"] });
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
