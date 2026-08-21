import { describe, test, expect } from "bun:test";
import { buildInitPlan, type HomeState } from "../init-plan.ts";

const PREFS_URL = "https://github.com/mattgoodwin/mattstack-prefs.git";

describe("buildInitPlan", () => {
  test("orders a fresh-adoption plan createRepo through push, unlink before adopt, adopt before fold", () => {
    const state: HomeState = {
      isRepo: false,
      hasUserClone: true,
      hasTeamClones: ["acme"],
      cruft: ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"],
      prefsRemoteUrl: PREFS_URL,
    };

    const plan = buildInitPlan(state);

    expect(plan.reason).toBeUndefined();
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "createRepo",
      "gitInit",
      "writeGitignore",
      "writeOwners",
      "deleteCruft",
      "unlinkUserClone",
      "adoptCommit",
      "foldInPrefs",
      "push",
    ]);

    const foldInPrefs = plan.steps.find((s) => s.kind === "foldInPrefs");
    expect(foldInPrefs).toEqual({ kind: "foldInPrefs", sourceUrl: PREFS_URL });
  });

  test("carries the cruft paths onto the deleteCruft step", () => {
    const state: HomeState = {
      isRepo: false,
      hasUserClone: true,
      hasTeamClones: [],
      cruft: ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"],
      prefsRemoteUrl: PREFS_URL,
    };

    const plan = buildInitPlan(state);
    const deleteCruft = plan.steps.find((s) => s.kind === "deleteCruft");
    expect(deleteCruft).toEqual({
      kind: "deleteCruft",
      paths: ["skills.jsonc.pre-pack", "skills.jsonc.retired-backup"],
    });
  });

  test("omits foldInPrefs and unlinkUserClone when there is no user clone to adopt", () => {
    const state: HomeState = { isRepo: false, hasUserClone: false, hasTeamClones: [], cruft: [] };
    const plan = buildInitPlan(state);
    expect(plan.steps.map((s) => s.kind)).not.toContain("foldInPrefs");
    expect(plan.steps.map((s) => s.kind)).not.toContain("unlinkUserClone");
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
      prefsRemoteUrl: PREFS_URL,
    };

    const plan = buildInitPlan(state);

    expect(plan.steps).toEqual([]);
    expect(plan.reason).toBe("already-initialized");
  });

  test("prefs-remote-unreadable: a user clone with no parseable origin URL fails loudly instead of emitting an unrunnable fold", () => {
    const state: HomeState = {
      isRepo: false,
      hasUserClone: true,
      hasTeamClones: [],
      cruft: [],
      prefsRemoteUrl: undefined,
    };

    const plan = buildInitPlan(state);

    expect(plan.steps).toEqual([]);
    expect(plan.reason).toBe("prefs-remote-unreadable");
  });

  test("isRepo takes precedence over an unreadable prefs remote", () => {
    const state: HomeState = {
      isRepo: true,
      hasUserClone: true,
      hasTeamClones: [],
      cruft: [],
      prefsRemoteUrl: undefined,
    };

    const plan = buildInitPlan(state);

    expect(plan.reason).toBe("already-initialized");
  });
});
