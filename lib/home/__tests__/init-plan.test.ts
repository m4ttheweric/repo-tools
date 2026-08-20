import { describe, test, expect } from "bun:test";
import { buildInitPlan, type HomeState } from "../init-plan.ts";

describe("buildInitPlan", () => {
  test("orders a fresh-adoption plan createRepo through push", () => {
    const state: HomeState = {
      isRepo: false,
      hasUserClone: true,
      hasTeamClones: ["acme"],
      cruft: ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"],
    };

    const plan = buildInitPlan(state);

    expect(plan.reason).toBeUndefined();
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "createRepo",
      "gitInit",
      "writeGitignore",
      "writeOwners",
      "deleteCruft",
      "foldInPrefs",
      "adoptCommit",
      "push",
    ]);
  });

  test("carries the cruft paths onto the deleteCruft step", () => {
    const state: HomeState = {
      isRepo: false,
      hasUserClone: true,
      hasTeamClones: [],
      cruft: ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"],
    };

    const plan = buildInitPlan(state);
    const deleteCruft = plan.steps.find((s) => s.kind === "deleteCruft");
    expect(deleteCruft).toEqual({
      kind: "deleteCruft",
      paths: ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"],
    });
  });

  test("omits foldInPrefs when there is no user clone to adopt", () => {
    const state: HomeState = { isRepo: false, hasUserClone: false, hasTeamClones: [], cruft: [] };
    const plan = buildInitPlan(state);
    expect(plan.steps.map((s) => s.kind)).not.toContain("foldInPrefs");
  });

  test("omits deleteCruft when there is no stray cruft", () => {
    const state: HomeState = { isRepo: false, hasUserClone: false, hasTeamClones: [], cruft: [] };
    const plan = buildInitPlan(state);
    expect(plan.steps.map((s) => s.kind)).not.toContain("deleteCruft");
  });

  test("push carries the same branch gitInit created", () => {
    const state: HomeState = { isRepo: false, hasUserClone: false, hasTeamClones: [], cruft: [] };
    const plan = buildInitPlan(state);
    const gitInit = plan.steps.find((s) => s.kind === "gitInit");
    const push = plan.steps.find((s) => s.kind === "push");
    expect(gitInit).toBeDefined();
    expect(push).toBeDefined();
    expect((push as { branch: string }).branch).toBe((gitInit as { branch: string }).branch);
  });

  test("already-initialized: returns no steps plus the reason", () => {
    const state: HomeState = {
      isRepo: true,
      hasUserClone: true,
      hasTeamClones: ["acme"],
      cruft: ["skills.jsonc.pre-pack"],
    };

    const plan = buildInitPlan(state);

    expect(plan.steps).toEqual([]);
    expect(plan.reason).toBe("already-initialized");
  });
});
