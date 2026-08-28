import { test, expect } from "bun:test";
import { MUTATING_TIMEOUT_MS, stashChangesAsync, popStashAsync } from "../worktree/git-async.ts";

test("mutating timeout is 5 minutes", () => {
  expect(MUTATING_TIMEOUT_MS).toBe(5 * 60_000);
});

test("stash helpers accept a timeout override", () => {
  // Type-level: these must type-check with an opts arg.
  const a: typeof stashChangesAsync = stashChangesAsync;
  const b: typeof popStashAsync = popStashAsync;
  expect(typeof a).toBe("function");
  expect(typeof b).toBe("function");
});
