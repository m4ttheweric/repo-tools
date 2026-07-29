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
});
