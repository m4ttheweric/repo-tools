/**
 * `findKnownRepo` — the one seam that answers "is this repo the one I am
 * standing in?".
 *
 * `KnownRepo.repoName` holds a SERIALIZED IDENTITY for every row the index
 * wrote post-cutover, while `RepoIdentity.repoName` is the human display
 * name. Matching those two against each other is the regression this seam
 * exists to make impossible: it never matches, so every caller silently
 * decided it was nowhere and fell through to a picker or a full rescan.
 */

import { describe, expect, test } from "bun:test";
import { findKnownRepo, type KnownRepo } from "../repo-index.ts";

const SKILLS_ID = "remote:github.com%2Fm4ttheweric%2Fskills";
const RT_ID = "remote:github.com%2Fm4ttstack%2Frt";

function repo(repoName: string, paths: string[]): KnownRepo {
  return {
    repoName,
    worktrees: paths.map((path) => ({ path, branch: "main", isBare: false })),
    dataDir: `/data/${repoName}`,
  };
}

describe("findKnownRepo", () => {
  test("finds an identity-keyed row whose display name differs from the directory", () => {
    const repos = [repo(RT_ID, ["/repos/repo-tools"]), repo(SKILLS_ID, ["/repos/matt-skills"])];

    const found = findKnownRepo(repos, { identity: SKILLS_ID, repoRoot: "/repos/matt-skills" });

    expect(found?.repoName).toBe(SKILLS_ID);
  });

  test("finds a legacy plain-name row by repo root", () => {
    const repos = [repo("skills", ["/repos/matt-skills"])];

    const found = findKnownRepo(repos, { identity: SKILLS_ID, repoRoot: "/repos/matt-skills" });

    expect(found?.repoName).toBe("skills");
  });

  test("finds the repo from inside one of its linked worktrees", () => {
    const repos = [repo(RT_ID, ["/repos/repo-tools", "/trees/frank-harbor"])];

    const found = findKnownRepo(repos, { identity: RT_ID, repoRoot: "/trees/frank-harbor" });

    expect(found?.repoName).toBe(RT_ID);
  });

  test("prefers the identity-keyed row over a legacy row for the same repo", () => {
    const repos = [repo("skills", ["/repos/matt-skills"]), repo(SKILLS_ID, ["/repos/matt-skills"])];

    const found = findKnownRepo(repos, { identity: SKILLS_ID, repoRoot: "/repos/matt-skills" });

    expect(found?.repoName).toBe(SKILLS_ID);
  });

  test("returns undefined for a repo the list does not carry", () => {
    const repos = [repo(RT_ID, ["/repos/repo-tools"])];

    const found = findKnownRepo(repos, { identity: SKILLS_ID, repoRoot: "/repos/matt-skills" });

    expect(found).toBeUndefined();
  });

  test("does not match a same-named legacy row belonging to a different directory", () => {
    const repos = [repo("skills", ["/repos/someone-elses-skills"])];

    const found = findKnownRepo(repos, { identity: SKILLS_ID, repoRoot: "/repos/matt-skills" });

    expect(found).toBeUndefined();
  });
});
