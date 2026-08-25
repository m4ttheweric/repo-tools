import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDiscussionsFileStore, rekeyDiscussionsTable } from "../discussions-file-store.ts";
import { resolveMRMeta, refreshDiscussions } from "../discussions-store.ts";
import { createProjectMRs } from "../project-mrs-store.ts";
import { closeStateDb, getStateDb, openStateDb } from "../../state/index.ts";
import type { HandlerContext } from "../handlers/types.ts";
import { fakeStore } from "./fake-cache-store.ts";

// RT-48 task 5: discussions persistence moved off discussions.json onto
// state.db's `discussions` table — stores are now constructed over a db
// handle (openStateDb(tempPath) seam), not a file path.
function tmpDb() {
  return openStateDb(join(mkdtempSync(join(tmpdir(), "rt-disc-")), "state.db"), "cli");
}

// RT-48: project-mrs persistence moved off project-mrs.json to state.db —
// each call opens a fresh temp db, same fresh-store-per-call isolation the
// old createProjectMRs(tmpPath(...), 0) pattern had.
function pmrsStore() {
  return createProjectMRs(tmpDb());
}
const note = (id: number) => ({ id, system: false, body: `n${id}`, createdAt: "2026-07-26T00:00:00Z", author: { id: "gitlab:user:777", name: "Luke", username: "luke" } });
const disc = (id: number) => ({ id: `d${id}`, notes: [note(id)] }) as any;

function fakeCtx(entries: Record<string, any>): HandlerContext {
  return { cache: fakeStore(entries), repoIndex: () => ({ repo: "/tmp/repo" }) } as unknown as HandlerContext;
}

describe("discussions store — row basics", () => {
  test("write/read/keys/remove round-trip against the discussions table", () => {
    const db = tmpDb();
    const s = createDiscussionsFileStore(db);
    s.write("repo", 7, { discussions: [disc(1)], fetchedAt: 123 });
    expect(s.read("repo", 7)!.fetchedAt).toBe(123);
    expect(s.keys()).toEqual([{ repoName: "repo", iid: 7 }]);
    s.remove("repo", 7);
    expect(s.read("repo", 7)).toBeUndefined();
    db.close();
  });

  test("write is a single-row upsert: touches exactly one row in the discussions table", () => {
    const db = tmpDb();
    const s = createDiscussionsFileStore(db);
    s.write("repo", 1, { discussions: [disc(1)], fetchedAt: 100 });
    s.write("repo", 2, { discussions: [disc(2)], fetchedAt: 200 });

    let rows = db.query("SELECT repo, iid, fetched_at FROM discussions;").all() as Array<{ repo: string; iid: number; fetched_at: number }>;
    expect(rows.length).toBe(2);

    // Re-writing MR 1 updates only its row — MR 2's row is untouched.
    s.write("repo", 1, { discussions: [disc(1), disc(3)], fetchedAt: 150 });
    rows = db.query("SELECT repo, iid, fetched_at FROM discussions ORDER BY iid;").all() as Array<{ repo: string; iid: number; fetched_at: number }>;
    expect(rows).toEqual([
      { repo: "repo", iid: 1, fetched_at: 150 },
      { repo: "repo", iid: 2, fetched_at: 200 },
    ]);
    db.close();
  });

  test("persists across store instances over the same db handle (no flush step)", () => {
    const db = tmpDb();
    createDiscussionsFileStore(db).write("repo", 7, { discussions: [disc(1)], fetchedAt: 123 });
    expect(createDiscussionsFileStore(db).read("repo", 7)!.fetchedAt).toBe(123);
    db.close();
  });

  test("read and write work under a serialized repo identity — the column is opaque to format", () => {
    const identity = "remote:gitlab.com%2Facme%2Fr";
    const db = tmpDb();
    const s = createDiscussionsFileStore(db);
    s.write(identity, 7, { discussions: [disc(1)], fetchedAt: 123 });
    expect(s.read(identity, 7)!.fetchedAt).toBe(123);
    expect(s.keys()).toEqual([{ repoName: identity, iid: 7 }]);
    db.close();
  });
});

describe("legacy import", () => {
  test("imports discussions.json rows, splitting the repo:iid key into columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-disc-legacy-"));
    const dbPath = join(dir, "state.db");
    const legacyPath = join(dir, "discussions.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        "repo-tools:7": { discussions: [disc(1)], fetchedAt: 111 },
        "gitq:3": { discussions: [], fetchedAt: 222 },
      }),
    );

    const db = openStateDb(dbPath, "cli");
    const store = createDiscussionsFileStore(db);

    expect(store.read("repo-tools", 7)).toEqual({ discussions: [disc(1)], fetchedAt: 111 });
    expect(store.read("gitq", 3)).toEqual({ discussions: [], fetchedAt: 222 });
    expect(store.keys().length).toBe(2);

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
    db.close();
  });

  test("a dir with no discussions.json imports nothing and creates no rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-disc-legacy-"));
    const db = openStateDb(join(dir, "state.db"), "cli");
    expect(createDiscussionsFileStore(db).keys()).toEqual([]);
    db.close();
  });
});

describe("resolveMRMeta", () => {
  test("branch entry wins; project store is the fallback; neither → null", () => {
    const pStore = pmrsStore();
    pStore.fullSync("repo", "g/p", [{ id: "gitlab:mr:9", iid: 9, title: "from project", state: "opened", sourceBranch: "x", targetBranch: "main", webUrl: "http://w/9", author: { id: "gitlab:user:42", username: "u", name: "U", avatarUrl: null }, divergedCommitsCount: null } as any], Date.now());
    const ctx = fakeCtx({
      feat: { repoName: "repo", mr: { iid: 5, title: "from branch", webUrl: "http://w/5", status: "open", author: { id: "gitlab:42" } }, ticket: null, linearId: "", fetchedAt: 0 },
    });
    const fromBranch = resolveMRMeta(ctx, "repo", 5, pStore)!;
    expect(fromBranch.title).toBe("from branch");
    expect(fromBranch.authorNumericId).toBe(42);
    const fromProject = resolveMRMeta(ctx, "repo", 9, pStore)!;
    expect(fromProject.title).toBe("from project");
    expect(fromProject.authorNumericId).toBe(42);
    expect(fromProject.terminal).toBe(false);
    expect(resolveMRMeta(ctx, "repo", 999, pStore)).toBeNull();
  });
});

describe("refreshDiscussions (lifted)", () => {
  test("writes the file store, not the branch entry; first fetch is silent; second diff notifies", async () => {
    const fileStore = createDiscussionsFileStore(tmpDb());
    const pStore = pmrsStore();
    const entries = {
      feat: { repoName: "repo", mr: { iid: 5, title: "T", webUrl: "http://w/5", status: "open", author: { id: "gitlab:1" } }, ticket: null, linearId: "", fetchedAt: 0 },
    };
    const ctx = fakeCtx(entries);
    const events: string[] = [];
    const deps = { ctx, broadcast: (t: string) => events.push(t) };
    const overrides = { fileStore, projectStore: pStore, fetchDiscussions: async () => [disc(1)] };

    const first = await refreshDiscussions(deps, "repo", 5, overrides);
    expect(first.newNotes).toEqual([]);                 // silent first fetch
    expect(fileStore.read("repo", 5)!.discussions.length).toBe(1);
    expect((entries.feat as any).discussions).toBeUndefined();  // branch entry untouched

    const second = await refreshDiscussions(deps, "repo", 5, { ...overrides, fetchDiscussions: async () => [disc(1), disc(2)] });
    // getCurrentUserId() is null in tests, so currentUserId===null and
    // meta.authorNumericId (1) can never equal it — isMrAuthor is false and
    // the notes are from a non-participant author (gitlab:777), so nothing
    // new surfaces.
    expect(second.newNotes.length).toBe(0);
    expect(events).toContain("discussions:update");
  });

  test("currentUserId override matching the branch entry's author marks isMrAuthor, surfacing new notes", async () => {
    const fileStore = createDiscussionsFileStore(tmpDb());
    const pStore = pmrsStore();
    const entries = {
      feat: { repoName: "repo", mr: { iid: 5, title: "T", webUrl: "http://w/5", status: "open", author: { id: "gitlab:1" } }, ticket: null, linearId: "", fetchedAt: 0 },
    };
    const ctx = fakeCtx(entries);
    const events: string[] = [];
    const notified: Array<[string, string, string, string | undefined]> = [];
    const deps = { ctx, broadcast: (t: string) => events.push(t) };
    const overrides = {
      fileStore, projectStore: pStore, fetchDiscussions: async () => [disc(1)], currentUserId: 1,
      // Without this the real emitter queues to ~/.mattstack/rt and pops a desktop banner.
      notify: (c: string, t: string, m: string, u?: string) => { notified.push([c, t, m, u]); },
    };

    const first = await refreshDiscussions(deps, "repo", 5, overrides);
    expect(first.newNotes).toEqual([]);
    expect(notified).toEqual([]);                        // first fetch stays silent

    const second = await refreshDiscussions(deps, "repo", 5, { ...overrides, fetchDiscussions: async () => [disc(1), disc(2)] });
    expect(second.newNotes.length).toBe(1);
    expect(events).toContain("discussions:update");
    expect(events).toContain("discussions:new-comments");

    // Routed through the notifier under a preference key, not broadcast raw:
    // that is what puts it in the durable queue and on the tray socket.
    expect(events).not.toContain("notification");
    expect(notified).toEqual([["new_comment", "New comment on !5", "@luke: n2", "http://w/5"]]);
  });

  // The provider stamps note authors in the scoped format "gitlab:user:N"
  // (glance NoteAuthor.id); fixtures must match or the self-filter is untested.
  const scopedNote = (id: number, userId: number, username: string) =>
    ({ id, system: false, body: `n${id}`, createdAt: "2026-07-26T00:00:00Z", author: { id: `gitlab:user:${userId}`, name: username, username } });

  test("own comments (scoped author id) never notify on my own MR", async () => {
    const fileStore = createDiscussionsFileStore(tmpDb());
    const pStore = pmrsStore();
    const ctx = fakeCtx({
      feat: { repoName: "repo", mr: { iid: 5, title: "T", webUrl: "http://w/5", status: "open", author: { id: "gitlab:1" } }, ticket: null, linearId: "", fetchedAt: 0 },
    });
    const notified: string[] = [];
    const deps = { ctx, broadcast: () => {} };
    const mine = scopedNote(1, 1, "matt");
    const overrides = {
      fileStore, projectStore: pStore, currentUserId: 1,
      fetchDiscussions: async () => [{ id: "d1", notes: [mine] } as any],
      notify: (c: string) => { notified.push(c); },
    };

    await refreshDiscussions(deps, "repo", 5, overrides);
    const second = await refreshDiscussions(deps, "repo", 5, {
      ...overrides,
      fetchDiscussions: async () => [{ id: "d1", notes: [mine, scopedNote(2, 1, "matt")] } as any],
    });
    expect(second.newNotes).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("teammate reply in a thread I participate in (scoped ids) notifies on someone else's MR", async () => {
    const fileStore = createDiscussionsFileStore(tmpDb());
    const pStore = pmrsStore();
    const ctx = fakeCtx({
      feat: { repoName: "repo", mr: { iid: 5, title: "T", webUrl: "http://w/5", status: "open", author: { id: "gitlab:2" } }, ticket: null, linearId: "", fetchedAt: 0 },
    });
    const notified: string[] = [];
    const deps = { ctx, broadcast: () => {} };
    const mine = scopedNote(1, 1, "matt");
    const overrides = {
      fileStore, projectStore: pStore, currentUserId: 1,
      fetchDiscussions: async () => [{ id: "d1", notes: [mine] } as any],
      notify: (c: string) => { notified.push(c); },
    };

    await refreshDiscussions(deps, "repo", 5, overrides);
    const second = await refreshDiscussions(deps, "repo", 5, {
      ...overrides,
      fetchDiscussions: async () => [{ id: "d1", notes: [mine, scopedNote(2, 777, "luke")] } as any],
    });
    expect(second.newNotes.length).toBe(1);
    expect(second.newNotes[0]!.authorUser).toBe("luke");
    expect(notified).toEqual(["new_comment"]);
  });

  test("throws for an MR in neither store", async () => {
    const overrides = { fileStore: createDiscussionsFileStore(tmpDb()), projectStore: pmrsStore(), fetchDiscussions: async () => [] };
    await expect(refreshDiscussions({ ctx: fakeCtx({}), broadcast: () => {} }, "repo", 1, overrides)).rejects.toThrow("MR not cached");
  });
});

describe("rekeyDiscussionsTable", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-disc-rekey-"));
    process.env.HOME = home;
    closeStateDb();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("a row already keyed by a serialized identity is left untouched", async () => {
    const identity = "remote:gitlab.com%2Fg%2Fr";
    const store = createDiscussionsFileStore(getStateDb());
    store.write(identity, 5, { discussions: [disc(1)], fetchedAt: 100 });

    const report = await rekeyDiscussionsTable();
    expect(report.migrated).toEqual([]);
    expect(store.read(identity, 5)!.discussions.length).toBe(1);
  });

  test("an unresolvable legacy repo name is retained and warned, never dropped", async () => {
    const store = createDiscussionsFileStore(getStateDb());
    store.write("ghost-repo", 5, { discussions: [disc(1)], fetchedAt: 100 });

    const report = await rekeyDiscussionsTable();
    expect(report.retained).toEqual(["ghost-repo"]);
    expect(store.read("ghost-repo", 5)!.discussions.length).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });
});
