import { describe, expect, test } from "bun:test";
import { numericUserId, MR_TERMINAL_STATES } from "../enrich.ts";
import { __test__ as discussionsStoreTest } from "../daemon/discussions-store.ts";
import { __test__ as discussionsPollerTest } from "../daemon/discussions-poller.ts";
import { __test__ as reconcilerTest } from "../daemon/worktree-reconciler.ts";

describe("numericUserId", () => {
  test("parses the numeric tail after the last colon", () => {
    expect(numericUserId("gitlab:user:12")).toBe(12);
  });

  test("parseInt stops at the first non-digit, so a trailing letter still yields a number", () => {
    expect(numericUserId("gitlab:user:12a")).toBe(12);
  });

  test("null and undefined both yield null", () => {
    expect(numericUserId(null)).toBe(null);
    expect(numericUserId(undefined)).toBe(null);
  });

  test("a tail with no leading digits yields null", () => {
    expect(numericUserId("gitlab:user:abc")).toBe(null);
  });

  test("a bare id with no colon is its own tail", () => {
    expect(numericUserId("42")).toBe(42);
  });
});

describe("MR_TERMINAL_STATES", () => {
  test("carries exactly merged and closed", () => {
    expect(MR_TERMINAL_STATES.has("merged")).toBe(true);
    expect(MR_TERMINAL_STATES.has("closed")).toBe(true);
    expect(MR_TERMINAL_STATES.has("opened")).toBe(false);
  });

  test("is the single source: discussions-store, discussions-poller, and worktree-reconciler all reference the same set", () => {
    expect(discussionsStoreTest.MR_TERMINAL_STATES).toBe(MR_TERMINAL_STATES);
    expect(discussionsPollerTest.MR_TERMINAL_STATES).toBe(MR_TERMINAL_STATES);
    expect(reconcilerTest.MR_TERMINAL_STATES).toBe(MR_TERMINAL_STATES);
  });
});
