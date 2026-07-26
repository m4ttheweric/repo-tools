import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDiscussionsFileStore, seedDiscussionsFromBranchCache } from "../discussions-file-store.ts";
import { resolveMRMeta, refreshDiscussions } from "../discussions-store.ts";
import { createProjectMRs } from "../project-mrs-store.ts";
import type { HandlerContext } from "../handlers/types.ts";

function tmpPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "rt-disc-")), name);
}
const note = (id: number) => ({ id, system: false, body: `n${id}`, createdAt: "2026-07-26T00:00:00Z", author: { id: "gitlab:777", name: "Luke", username: "luke" } });
const disc = (id: number) => ({ id: `d${id}`, notes: [note(id)] }) as any;

function fakeCtx(entries: Record<string, any>): HandlerContext {
  return { cache: { entries }, flushCache: () => {}, loadCache: () => {}, repoIndex: () => ({ repo: "/tmp/repo" }) } as unknown as HandlerContext;
}

describe("file store basics + seed", () => {
  test("write/read/keys/remove round-trip and persist", () => {
    const p = tmpPath("d.json");
    const s = createDiscussionsFileStore(p);
    s.write("repo", 7, { discussions: [disc(1)], fetchedAt: 123 });
    expect(s.read("repo", 7)!.fetchedAt).toBe(123);
    expect(s.keys()).toEqual([{ repoName: "repo", iid: 7 }]);
    s.flushNow();
    expect(createDiscussionsFileStore(p).read("repo", 7)!.fetchedAt).toBe(123);
    s.remove("repo", 7);
    expect(s.read("repo", 7)).toBeUndefined();
  });

  test("seed copies embedded discussions, skips entries without repoName", () => {
    const s = createDiscussionsFileStore(tmpPath("d.json"));
    const n = seedDiscussionsFromBranchCache({
      a: { repoName: "repo", mr: { iid: 1 }, discussions: [disc(1)], discussionsFetchedAt: 5, ticket: null, linearId: "", fetchedAt: 0 },
      b: { mr: { iid: 2 }, discussions: [disc(2)], discussionsFetchedAt: 6, ticket: null, linearId: "", fetchedAt: 0 } as any,
      c: { repoName: "repo", mr: { iid: 3 }, ticket: null, linearId: "", fetchedAt: 0 } as any,
    } as any, s);
    expect(n).toBe(1);
    expect(s.read("repo", 1)!.fetchedAt).toBe(5);
    expect(s.read("repo", 2)).toBeUndefined();
  });

  test("seed never overwrites an existing store entry", () => {
    const s = createDiscussionsFileStore(tmpPath("d.json"));
    s.write("repo", 1, { discussions: [], fetchedAt: 999 });
    seedDiscussionsFromBranchCache({
      a: { repoName: "repo", mr: { iid: 1 }, discussions: [disc(1)], discussionsFetchedAt: 5, ticket: null, linearId: "", fetchedAt: 0 },
    } as any, s);
    expect(s.read("repo", 1)!.fetchedAt).toBe(999);
  });
});

describe("resolveMRMeta", () => {
  test("branch entry wins; project store is the fallback; neither → null", () => {
    const pStore = createProjectMRs(tmpPath("p.json"), 0);
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
    const fileStore = createDiscussionsFileStore(tmpPath("d.json"));
    const pStore = createProjectMRs(tmpPath("p.json"), 0);
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
    const fileStore = createDiscussionsFileStore(tmpPath("d.json"));
    const pStore = createProjectMRs(tmpPath("p.json"), 0);
    const entries = {
      feat: { repoName: "repo", mr: { iid: 5, title: "T", webUrl: "http://w/5", status: "open", author: { id: "gitlab:1" } }, ticket: null, linearId: "", fetchedAt: 0 },
    };
    const ctx = fakeCtx(entries);
    const events: string[] = [];
    const deps = { ctx, broadcast: (t: string) => events.push(t) };
    const overrides = { fileStore, projectStore: pStore, fetchDiscussions: async () => [disc(1)], currentUserId: 1 };

    const first = await refreshDiscussions(deps, "repo", 5, overrides);
    expect(first.newNotes).toEqual([]);

    const second = await refreshDiscussions(deps, "repo", 5, { ...overrides, fetchDiscussions: async () => [disc(1), disc(2)] });
    expect(second.newNotes.length).toBe(1);
    expect(events).toContain("discussions:update");
  });

  test("throws for an MR in neither store", async () => {
    const overrides = { fileStore: createDiscussionsFileStore(tmpPath("d.json")), projectStore: createProjectMRs(tmpPath("p.json"), 0), fetchDiscussions: async () => [] };
    await expect(refreshDiscussions({ ctx: fakeCtx({}), broadcast: () => {} }, "repo", 1, overrides)).rejects.toThrow("MR not cached");
  });
});
