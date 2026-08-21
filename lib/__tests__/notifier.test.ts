import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { userSettingsPath } from "../rt-paths.ts";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import { __test__, loadNotificationPrefs, saveNotificationPrefs, NOTIFICATION_TYPES } from "../notifier.ts";

describe("notification prefs through the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-notifier-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("empty store: every notification type defaults to enabled", () => {
    const prefs = loadNotificationPrefs();
    for (const t of NOTIFICATION_TYPES) expect(prefs[t.key]).toBe(true);
  });

  test("a store-seeded value resolves through the loader", () => {
    setSetting("rt.notifications", { pipeline_failed: false }, "user");

    const prefs = loadNotificationPrefs();
    expect(prefs.pipeline_failed).toBe(false);
    expect(prefs.mr_merged).toBe(true); // untouched types still default true
  });

  test("saveNotificationPrefs lands in the user store", () => {
    saveNotificationPrefs({ pipeline_failed: false, mr_merged: true });

    const stored = getSetting<Record<string, boolean>>("rt.notifications").value;
    expect(stored.pipeline_failed).toBe(false);
    const raw = JSON.parse(readFileSync(userSettingsPath(), "utf8").replace(/^\/\/.*\n/, ""));
    expect(raw["rt.notifications"]).toEqual({ pipeline_failed: false, mr_merged: true });
  });
});

const baseSnapshot = {
  pipelineStatus: null,
  mrState: "opened",
  approved: false,
  approvedByUserIds: [] as string[],
  conflicts: false,
  conflictFreeStreak: 1,
  needsRebase: false,
  isReady: false,
  mergeError: null,
  statusDetail: null as string | null,
};

describe("approval transition notifications", () => {
  test("suppresses MR approved notification when my approval newly appears", () => {
    const was = { ...baseSnapshot };
    const now = {
      ...baseSnapshot,
      approved: true,
      approvedByUserIds: ["123"],
    };

    expect(__test__.shouldNotifyApprovalTransition(was, now, 123)).toBe("self-approved");
  });

  test("notifies when another approval completes an MR I had already approved", () => {
    const was = {
      ...baseSnapshot,
      approvedByUserIds: ["123"],
    };
    const now = {
      ...baseSnapshot,
      approved: true,
      approvedByUserIds: ["123", "456"],
    };

    expect(__test__.shouldNotifyApprovalTransition(was, now, 123)).toBe("notify");
  });

  test("notifies when current user id is not available", () => {
    const was = { ...baseSnapshot };
    const now = {
      ...baseSnapshot,
      approved: true,
      approvedByUserIds: ["123"],
    };

    expect(__test__.shouldNotifyApprovalTransition(was, now, null)).toBe("notify");
  });

  test("does not notify when approved flips with no new approver", () => {
    const was = { ...baseSnapshot, approvedByUserIds: ["456"] };
    const now = { ...baseSnapshot, approved: true, approvedByUserIds: ["456"] };
    expect(__test__.shouldNotifyApprovalTransition(was, now, 123)).toBe("no-new-approver");
  });

  test("does not notify when approved flips with an empty approver list", () => {
    const was = { ...baseSnapshot };
    const now = { ...baseSnapshot, approved: true };
    expect(__test__.shouldNotifyApprovalTransition(was, now, 123)).toBe("no-new-approver");
  });
});

/** Build a fake cache entry's MR slot for snapshotBranch(). */
function mrEntry(mr: Record<string, unknown>) {
  return { ticket: null, linearId: "", fetchedAt: 0, mr } as any;
}

describe("author gate", () => {
  const authored = (authorId: string) =>
    mrEntry({ author: { id: authorId }, pipeline: { status: "failed" } });

  test("recognizes an MR authored by the current user (scoped id)", () => {
    expect(__test__.isSelfAuthored(authored("gitlab:123"), 123)).toBe(true);
  });

  test("suppresses an MR authored by someone else", () => {
    expect(__test__.isSelfAuthored(authored("gitlab:456"), 123)).toBe(false);
  });

  test("strict: suppresses when current user id is unresolved", () => {
    expect(__test__.isSelfAuthored(authored("gitlab:123"), null)).toBe(false);
  });

  test("suppresses when the MR carries no author", () => {
    expect(__test__.isSelfAuthored(mrEntry({ pipeline: { status: "failed" } }), 123)).toBe(false);
  });
});

describe("snapshotBranch readiness", () => {
  test("is NOT ready when GitLab is transiently re-checking an unreviewed MR", () => {
    // GitLab parks MRs in `unchecked`/`checking` on every push, pipeline event,
    // or target-branch advance. The SDK's optimistic isReady reports true during
    // that window even though the MR has no approvals — we must not treat it ready.
    const snap = __test__.snapshotBranch(mrEntry({
      state: "opened",
      statusDetail: "unchecked",
      isReady: true, // optimistic SDK value
      reviews: { isApproved: false },
      blockers: { awaitingApprovals: true, hasConflicts: false },
    }));
    expect(snap.isReady).toBe(false);
  });

  test("is ready only when GitLab settles on `mergeable` and approvals are met", () => {
    const snap = __test__.snapshotBranch(mrEntry({
      state: "opened",
      statusDetail: "mergeable",
      isReady: true,
      reviews: { isApproved: true },
      blockers: { awaitingApprovals: false, hasConflicts: false },
    }));
    expect(snap.isReady).toBe(true);
  });

  test("is NOT ready when settled mergeable but approvals still outstanding", () => {
    const snap = __test__.snapshotBranch(mrEntry({
      state: "opened",
      statusDetail: "mergeable",
      isReady: true,
      reviews: { isApproved: false },
      blockers: { awaitingApprovals: true, hasConflicts: false },
    }));
    expect(snap.isReady).toBe(false);
  });

  test("is NOT ready when the MR is stacked, even with approvals met", () => {
    const snap = __test__.snapshotBranch(mrEntry({
      state: "opened",
      statusDetail: "mergeable",
      isReady: true,
      isStacked: true,
      reviews: { isApproved: true },
      blockers: { awaitingApprovals: false, hasConflicts: false },
    }));
    expect(snap.isReady).toBe(false);
  });
});

describe("ready-to-merge re-arming", () => {
  const ready = { ...baseSnapshot, isReady: true, approved: true, statusDetail: "mergeable" };

  test("does NOT re-arm while GitLab is transiently re-checking", () => {
    const now = { ...ready, isReady: false, statusDetail: "unchecked" };
    expect(__test__.shouldRearmReady(ready, now)).toBe(false);
  });

  test("re-arms when a real blocker reappears (lost approval)", () => {
    const now = { ...ready, isReady: false, approved: false, statusDetail: "not_approved" };
    expect(__test__.shouldRearmReady(ready, now)).toBe(true);
  });

  test("re-arms when CI starts running again", () => {
    const now = { ...ready, isReady: false, statusDetail: "ci_still_running" };
    expect(__test__.shouldRearmReady(ready, now)).toBe(true);
  });

  test("never re-arms when it was not ready to begin with", () => {
    const was = { ...baseSnapshot, isReady: false };
    const now = { ...baseSnapshot, isReady: false, statusDetail: "not_approved" };
    expect(__test__.shouldRearmReady(was, now)).toBe(false);
  });

  test("does NOT re-arm during 'preparing', the just-created-MR window", () => {
    const now = { ...ready, isReady: false, statusDetail: "preparing" };
    expect(__test__.shouldRearmReady(ready, now)).toBe(false);
  });
});

describe("merge-conflict re-arming", () => {
  const conflicted = { ...baseSnapshot, conflicts: true, conflictFreeStreak: 0, statusDetail: "not_approved" };

  // The MRs that flapped worst sat at a settled `not_approved` throughout, so
  // a transitional-status test alone would not have held the key.
  test("does NOT re-arm on a single conflict-free observation", () => {
    const now = { ...conflicted, conflicts: false, conflictFreeStreak: 1 };
    expect(__test__.shouldRearmConflicts(conflicted, now)).toBe(false);
  });

  test("re-arms once the negative holds across observations", () => {
    const now = { ...conflicted, conflicts: false, conflictFreeStreak: 2 };
    expect(__test__.shouldRearmConflicts(conflicted, now)).toBe(true);
  });

  test("does NOT re-arm while GitLab is re-checking, however long the streak", () => {
    const now = { ...conflicted, conflicts: false, conflictFreeStreak: 9, statusDetail: "checking" };
    expect(__test__.shouldRearmConflicts(conflicted, now)).toBe(false);
  });

  test("never re-arms while the conflict is still reported", () => {
    const now = { ...conflicted, conflicts: true, conflictFreeStreak: 0 };
    expect(__test__.shouldRearmConflicts(conflicted, now)).toBe(false);
  });

  test("never re-arms when there was no conflict to begin with", () => {
    const was = { ...baseSnapshot, conflicts: false, conflictFreeStreak: 5 };
    const now = { ...baseSnapshot, conflicts: false, conflictFreeStreak: 6 };
    expect(__test__.shouldRearmConflicts(was, now)).toBe(false);
  });
});

describe("conflict-free streak", () => {
  const entry = (hasConflicts: boolean) => ({
    ticket: null,
    linearId: "",
    fetchedAt: 0,
    mr: { blockers: { hasConflicts }, state: "opened" },
  });

  test("counts up across conflict-free observations", () => {
    const first = __test__.snapshotBranch(entry(false));
    expect(first.conflictFreeStreak).toBe(1);
    expect(__test__.snapshotBranch(entry(false), first).conflictFreeStreak).toBe(2);
  });

  test("resets the moment a conflict is reported", () => {
    const prev = { ...baseSnapshot, conflictFreeStreak: 7 };
    expect(__test__.snapshotBranch(entry(true), prev).conflictFreeStreak).toBe(0);
  });

  test("a blink between two conflicted reads never reaches the re-arm threshold", () => {
    // conflicted -> blink -> conflicted, the exact 5-minute pattern from the logs
    let snap = __test__.snapshotBranch(entry(true));
    const conflicted = snap;
    snap = __test__.snapshotBranch(entry(false), snap);
    expect(__test__.shouldRearmConflicts(conflicted, snap)).toBe(false);
  });
});
