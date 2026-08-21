import { describe, test, expect } from "bun:test";
import { buildInitPlan, InvalidMachineKeyError, STATE_DIR_NAMES, type HomeState, type InitPlanConfig } from "../init-plan.ts";

const CONFIG: InitPlanConfig = { url: "https://github.com/m4ttheweric/mattstack-home", machineKey: "mbp-14" };

const FRESH_STATE: HomeState = {
  userRepoPresent: false,
  machineKeyFilePresent: false,
  profileDirPresent: false,
  skillsSymlinkPresent: false,
  skillsSymlinkBlocked: false,
  stateDirsMissing: [...STATE_DIR_NAMES],
};

const FULLY_PROVISIONED_STATE: HomeState = {
  userRepoPresent: true,
  machineKeyFilePresent: true,
  profileDirPresent: true,
  skillsSymlinkPresent: true,
  skillsSymlinkBlocked: false,
  stateDirsMissing: [],
};

describe("buildInitPlan", () => {
  test("fresh HOME: emits every step in order", () => {
    const plan = buildInitPlan(FRESH_STATE, CONFIG);

    expect(plan.blocked).toBeUndefined();
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "ensureStateDirs",
      "cloneUserRepo",
      "writeGitignore",
      "writeOwners",
      "writeMachineKey",
      "ensureProfileDir",
      "writeSkillsSymlink",
    ]);
    expect(plan.steps[0]).toEqual({ kind: "ensureStateDirs", dirs: STATE_DIR_NAMES });
    expect(plan.steps[1]).toEqual({ kind: "cloneUserRepo", url: CONFIG.url });
    expect(plan.steps.find((s) => s.kind === "writeMachineKey")).toEqual({
      kind: "writeMachineKey",
      key: "mbp-14",
    });
    expect(plan.steps.find((s) => s.kind === "ensureProfileDir")).toEqual({
      kind: "ensureProfileDir",
      key: "mbp-14",
    });
  });

  test("repo present: skips clone and the gitignore/owners that ride with it — provisioning-only", () => {
    const state: HomeState = {
      ...FRESH_STATE,
      userRepoPresent: true,
      stateDirsMissing: [],
    };

    const plan = buildInitPlan(state, CONFIG);

    expect(plan.steps.map((s) => s.kind)).toEqual(["writeMachineKey", "ensureProfileDir", "writeSkillsSymlink"]);
  });

  test("real file at the symlink path: blocked, but every other applicable step still runs", () => {
    const state: HomeState = {
      ...FRESH_STATE,
      skillsSymlinkBlocked: true,
    };

    const plan = buildInitPlan(state, CONFIG);

    expect(plan.blocked).toBe("skills-symlink-real-file");
    expect(plan.steps.map((s) => s.kind)).not.toContain("writeSkillsSymlink");
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "ensureStateDirs",
      "cloneUserRepo",
      "writeGitignore",
      "writeOwners",
      "writeMachineKey",
      "ensureProfileDir",
    ]);
  });

  test("machine-key file present: no writeMachineKey step, but profile dir and symlink are unaffected", () => {
    const state: HomeState = { ...FRESH_STATE, machineKeyFilePresent: true };

    const plan = buildInitPlan(state, CONFIG);

    expect(plan.steps.map((s) => s.kind)).not.toContain("writeMachineKey");
    expect(plan.steps.map((s) => s.kind)).toEqual([
      "ensureStateDirs",
      "cloneUserRepo",
      "writeGitignore",
      "writeOwners",
      "ensureProfileDir",
      "writeSkillsSymlink",
    ]);
  });

  test("profile dir present: no ensureProfileDir step", () => {
    const state: HomeState = { ...FRESH_STATE, profileDirPresent: true };
    const plan = buildInitPlan(state, CONFIG);
    expect(plan.steps.map((s) => s.kind)).not.toContain("ensureProfileDir");
  });

  test("skills symlink already correct: no writeSkillsSymlink step", () => {
    const state: HomeState = { ...FRESH_STATE, skillsSymlinkPresent: true };
    const plan = buildInitPlan(state, CONFIG);
    expect(plan.steps.map((s) => s.kind)).not.toContain("writeSkillsSymlink");
  });

  test("no state dirs missing: no ensureStateDirs step", () => {
    const state: HomeState = { ...FRESH_STATE, stateDirsMissing: [] };
    const plan = buildInitPlan(state, CONFIG);
    expect(plan.steps.map((s) => s.kind)).not.toContain("ensureStateDirs");
  });

  test("ensureStateDirs carries only the missing dirs, not the full list", () => {
    const state: HomeState = { ...FRESH_STATE, stateDirsMissing: ["work", "teams"] };
    const plan = buildInitPlan(state, CONFIG);
    expect(plan.steps.find((s) => s.kind === "ensureStateDirs")).toEqual({
      kind: "ensureStateDirs",
      dirs: ["work", "teams"],
    });
  });

  test("fully provisioned: empty plan, not blocked", () => {
    const plan = buildInitPlan(FULLY_PROVISIONED_STATE, CONFIG);
    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toBeUndefined();
  });

  test("blocked takes precedence even when nothing else needs doing", () => {
    const state: HomeState = { ...FULLY_PROVISIONED_STATE, skillsSymlinkPresent: false, skillsSymlinkBlocked: true };
    const plan = buildInitPlan(state, CONFIG);
    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toBe("skills-symlink-real-file");
  });

  test("STATE_DIR_NAMES includes ci-attendants (per the spec's state-zone tree)", () => {
    expect(STATE_DIR_NAMES).toContain("ci-attendants");
  });

  describe("machine-key guard — refuses before ever emitting writeMachineKey/ensureProfileDir", () => {
    test.each([
      ["empty", ""],
      ["exactly \".\"", "."],
      ["exactly \"..\"", ".."],
      ["a forward slash", "evil/key"],
      ["a backslash", "evil\\key"],
    ])("%s: throws InvalidMachineKeyError, never returns a plan", (_label, badKey) => {
      expect(() => buildInitPlan(FRESH_STATE, { ...CONFIG, machineKey: badKey })).toThrow(InvalidMachineKeyError);
    });

    test("a safe key still builds the plan normally", () => {
      expect(() => buildInitPlan(FRESH_STATE, { ...CONFIG, machineKey: "mbp-14" })).not.toThrow();
    });

    test("the guard applies even when nothing else in the plan needs the key (fully provisioned)", () => {
      expect(() => buildInitPlan(FULLY_PROVISIONED_STATE, { ...CONFIG, machineKey: "../escape" })).toThrow(
        InvalidMachineKeyError,
      );
    });
  });
});
