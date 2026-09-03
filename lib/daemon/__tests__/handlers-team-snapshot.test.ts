import { describe, test, expect } from "bun:test";
import { createTeamSnapshotHandlers } from "../handlers/team-snapshot.ts";
import { UserActionableError } from "../../setup/errors.ts";

const fakeHandle = {
  status: () => [{ slug: "acme", id: "team:acme" }],
  pullNow: async (slug: string) => {
    if (slug !== "acme") throw new UserActionableError("no-team", `team "${slug}" is not cloned locally`);
    return { outcome: "up-to-date" as const, detail: null };
  },
} as unknown as import("../team-snapshots.ts").TeamSnapshotsHandle;

describe("team snapshot handlers", () => {
  test("status returns every entry; pull routes by slug; unknown slug is a user error, not a throw", async () => {
    const h = createTeamSnapshotHandlers(fakeHandle);
    expect(await h["team:snapshot-status"]({})).toEqual({ ok: true, data: [{ slug: "acme", id: "team:acme" }] });
    expect(await h["team:pull"]({ slug: "acme" })).toEqual({ ok: true, data: { outcome: "up-to-date", detail: null } });
    const bad = await h["team:pull"]({ slug: "nope" });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string; failure: { code: string } }).error).toContain("not cloned");
    expect((bad as { error: string; failure: { code: string } }).failure.code).toBe("no-team");
  });
});
