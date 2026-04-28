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
