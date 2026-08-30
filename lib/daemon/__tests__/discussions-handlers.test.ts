/**
 * discussions:read hard-cutover gate: a bare legacy repo name must
 * resolve nothing rather than reading a `discussions` row that no longer
 * exists under that key, and must never reach the store/grants at all.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb } from "../../state/index.ts";
import { getDiscussionsFileStore } from "../discussions-file-store.ts";
import { createDiscussionHandlers } from "../handlers/discussions.ts";
import { fakeStore } from "./fake-cache-store.ts";

const fakeCtx = { repoIndex: () => ({}), cache: fakeStore({}) };

describe("discussions:read", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-disc-handlers-"));
    process.env.HOME = home;
    closeStateDb();
  });
  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("discussions:reply returns ok:false for a non-string body instead of throwing at trim()", async () => {
    const h = createDiscussionHandlers(fakeCtx, () => {});
    const res = await h["discussions:reply"]!({ repoName: "x", iid: 1, discussionId: "d", body: 42 } as unknown as never);
    expect(res.ok).toBe(false);
  });

  test("a bare legacy name resolves nothing; the same read resolves under a serialized identity", async () => {
    const identity = "remote:gitlab.com%2Fg%2Frepo-tools";
    const store = getDiscussionsFileStore();
    store.write("repo-tools", 1, { discussions: [{ id: "d1" } as any], fetchedAt: Date.now() });
    store.write(identity, 2, { discussions: [{ id: "d2" } as any], fetchedAt: Date.now() });
    const h = createDiscussionHandlers(fakeCtx, () => {});

    const legacy = await h["discussions:read"]!({ repoName: "repo-tools", iid: 1 });
    expect(legacy).toEqual({ ok: true, data: { discussions: [], fetchedAt: 0, stale: true } });

    const viaIdentity = await h["discussions:read"]!({ repoName: identity, iid: 2 });
    expect(viaIdentity.ok).toBe(true);
    if (viaIdentity.ok) {
      expect(viaIdentity.data.discussions).toEqual([{ id: "d2" } as any]);
      expect(viaIdentity.data.stale).toBe(false);
    }
  });
});
