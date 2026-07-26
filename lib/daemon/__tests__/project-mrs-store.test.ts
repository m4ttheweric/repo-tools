import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProjectMRs } from "../project-mrs-store.ts";
import type { PullRequest } from "@workforge/glance-sdk";

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "rt-pmrs-")), "project-mrs.json");
}

/** Minimal PullRequest-shaped object; the store treats prs as opaque JSON. */
function pr(iid: number, over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `gitlab:mr:${iid}`, iid, title: `MR ${iid}`, state: "opened",
    sourceBranch: `feat-${iid}`, targetBranch: "main",
    webUrl: `https://gitlab.example/g/p/-/merge_requests/${iid}`,
    divergedCommitsCount: null,
    ...over,
  } as unknown as PullRequest;
}

describe("upsert", () => {
  test("no record + null projectPath → no-op", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    expect(s.upsert("repo", null, pr(1), "mutation")).toEqual([]);
    expect(s.read("repo")).toBeUndefined();
  });

  test("writes entry, returns changed iid, keeps terminal states", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    s.fullSync("repo", "g/p", [pr(1)], Date.now());
    expect(s.upsert("repo", null, pr(2, { state: "merged" } as any), "events")).toEqual([2]);
    expect(s.read("repo")!.mrs[2]!.pr.state).toBe("merged");
    expect(s.read("repo")!.source).toBe("events");
  });
});

describe("fullSync reconcile", () => {
  test("replaces stale entries and prunes stale absentees", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    const t0 = Date.now() - 10_000;
    s.fullSync("repo", "g/p", [pr(1), pr(2)], t0);
    const changed = s.fullSync("repo", "g/p", [pr(1, { title: "updated" } as any)], Date.now() - 1000);
    expect(changed).toContain(1);
    expect(changed).toContain(2);            // pruned counts as changed
    expect(s.read("repo")!.mrs[1]!.pr.title).toBe("updated");
    expect(s.read("repo")!.mrs[2]).toBeUndefined();
  });

  test("concurrent upsert survives: entry with fetchedAt > syncStartedAt is kept", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    const syncStartedAt = Date.now() - 5000;
    s.fullSync("repo", "g/p", [pr(1)], syncStartedAt - 1);
    s.upsert("repo", null, pr(1, { state: "merged" } as any), "mutation"); // fetchedAt = now > syncStartedAt
    s.fullSync("repo", "g/p", [pr(1)], syncStartedAt);                     // stale sync result says opened
    expect(s.read("repo")!.mrs[1]!.pr.state).toBe("merged");               // mutation won
  });

  test("mid-sync-created entry survives pruning", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    const syncStartedAt = Date.now() - 5000;
    s.fullSync("repo", "g/p", [], syncStartedAt - 1);
    s.upsert("repo", null, pr(9), "events"); // arrives after record exists... see note below
    s.fullSync("repo", "g/p", [], syncStartedAt); // sync result predates the event
    expect(s.read("repo")!.mrs[9]).toBeDefined();
  });

  test("null diverged in sync preserves an existing non-null value", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    s.fullSync("repo", "g/p", [pr(1)], Date.now() - 10_000);
    s.upsert("repo", null, pr(1, { divergedCommitsCount: 3 } as any), "events");
    s.fullSync("repo", "g/p", [pr(1, { divergedCommitsCount: null } as any)], Date.now());
    expect((s.read("repo")!.mrs[1]!.pr as any).divergedCommitsCount).toBe(3);
  });

  test("listSyncedAt records the sync START time", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    const started = Date.now() - 1234;
    s.fullSync("repo", "g/p", [pr(1)], started);
    expect(s.read("repo")!.listSyncedAt).toBe(started);
  });
});

describe("findBySourceBranch / load tolerance / flush", () => {
  test("findBySourceBranch matches open MRs only", () => {
    const s = createProjectMRs(tmpStorePath(), 0);
    s.fullSync("repo", "g/p", [pr(1), pr(2, { state: "merged", sourceBranch: "feat-2" } as any)], Date.now());
    expect(s.findBySourceBranch("repo", "feat-1")!.iid).toBe(1);
    expect(s.findBySourceBranch("repo", "feat-2")).toBeNull();
    expect(s.findBySourceBranch("repo", "nope")).toBeNull();
  });

  test("corrupt file loads as empty; flushNow round-trips", () => {
    const p = tmpStorePath();
    writeFileSync(p, "{broken");
    const s = createProjectMRs(p, 0);
    expect(s.read("repo")).toBeUndefined();
    s.fullSync("repo", "g/p", [pr(1)], Date.now());
    s.flushNow();
    const reloaded = createProjectMRs(p, 0);
    expect(reloaded.read("repo")!.mrs[1]!.pr.iid).toBe(1);
  });
});
