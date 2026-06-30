import { describe, expect, test } from "bun:test";
import { __test__ } from "../notifier.ts";

const baseSnapshot = {
  pipelineStatus: null,
  mrState: "opened",
  approved: false,
  approvedByUserIds: [] as string[],
  conflicts: false,
  needsRebase: false,
  isReady: false,
  mergeError: null,
  ticketState: null,
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

    expect(__test__.shouldNotifyApprovalTransition(was, now, 123)).toBe(false);
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

    expect(__test__.shouldNotifyApprovalTransition(was, now, 123)).toBe(true);
  });

  test("notifies when current user id is not available", () => {
    const was = { ...baseSnapshot };
    const now = {
      ...baseSnapshot,
      approved: true,
      approvedByUserIds: ["123"],
    };

    expect(__test__.shouldNotifyApprovalTransition(was, now, null)).toBe(true);
  });
});

/** Build a fake cache entry's MR slot for snapshotBranch(). */
function mrEntry(mr: Record<string, unknown>) {
  return { ticket: null, linearId: "", fetchedAt: 0, mr } as any;
}

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
});
