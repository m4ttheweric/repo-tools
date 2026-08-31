import { test, expect } from "bun:test";
import { RunAborted, resolveRun } from "../run.ts";

test("RunAborted carries the exit code the picker would have used", () => {
  const e = new RunAborted(1, "cancelled");
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe(1);
  expect(e.message).toBe("cancelled");
});

test("resolveRun with no known repos and no context resolves cancelled, never exits the process", async () => {
  // The picker chain's first gate is the repo index; with an empty index it
  // used to process.exit(1). Now it must come back as a cancellation.
  const res = await resolveRun([], { identity: undefined } as never);
  expect(res.kind).toBe("cancelled");
  if (res.kind === "cancelled") expect(res.code).toBe(1);
});
