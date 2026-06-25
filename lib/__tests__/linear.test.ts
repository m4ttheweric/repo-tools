import { describe, test, expect } from "bun:test";
import { pickStartedState } from "../linear.ts";

describe("pickStartedState", () => {
  // Reproduces the Acme (Derpy) team: many `started`-type states, where the
  // API returns "Ready for Merge" first but "In Progress" (position 0) is the
  // real entry point into the started group.
  const acmeStates = [
    { id: "merge", type: "started", position: 4000 },
    { id: "stale", type: "canceled", position: 0 },
    { id: "ready-testing", type: "started", position: 2000 },
    { id: "code-review", type: "started", position: 1000 },
    { id: "in-progress", type: "started", position: 0 },
    { id: "todo", type: "unstarted", position: 0 },
    { id: "done", type: "completed", position: 0 },
  ];

  test("picks the lowest-position started state, not the first in the array", () => {
    expect(pickStartedState(acmeStates)?.id).toBe("in-progress");
  });

  test("returns null when there is no started state", () => {
    expect(
      pickStartedState([
        { id: "todo", type: "unstarted", position: 0 },
        { id: "done", type: "completed", position: 1000 },
      ]),
    ).toBeNull();
  });

  test("falls back to the single started state when only one exists", () => {
    expect(
      pickStartedState([
        { id: "backlog", type: "backlog", position: 0 },
        { id: "doing", type: "started", position: 500 },
      ])?.id,
    ).toBe("doing");
  });
});
