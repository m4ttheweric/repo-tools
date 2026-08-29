import { test, expect } from "bun:test";
import { getRepoContext } from "../freshness.ts";

test("getRepoContext repo-not-in-index error names rt repos register, not rt repo add or repos.json", async () => {
  const repoName = "rt-b5-repo-index-message-test-nonexistent";
  let thrown: unknown;
  try {
    await getRepoContext(repoName);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toMatch(/rt repos register/);
  expect(message).not.toMatch(/rt repo add/);
  expect(message).not.toMatch(/repos\.json/);
});
