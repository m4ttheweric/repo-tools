import { describe, test, expect } from "bun:test";
import {
  buildInitPlan,
  chooseMachineProfile,
  InvalidMachineKeyError,
  InvalidProfileKeyError,
  ProfileChoiceRequiredError,
  ProfileNameCollisionError,
  STATE_DIR_NAMES,
  UnknownProfileFlagError,
  type ChooseMachineProfileInput,
  type HomeState,
  type InitPlanConfig,
} from "../init-plan.ts";

const TEST_URL = "https://github.com/m4ttheweric/mattstack-home";
const CONFIG: InitPlanConfig = { url: TEST_URL, machineKey: "mbp-14" };

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

function freshState(): HomeState {
  return { ...FRESH_STATE };
}

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
    expect(plan.steps[1]).toEqual({ kind: "cloneUserRepo", url: TEST_URL });
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

  describe("local-only init (config.url === null)", () => {
    test("no url plans initUserRepo instead of cloneUserRepo", () => {
      const plan = buildInitPlan(freshState(), { url: null, machineKey: "m" });
      expect(plan.steps.some((s) => s.kind === "initUserRepo")).toBe(true);
      expect(plan.steps.some((s) => s.kind === "cloneUserRepo")).toBe(false);
    });

    test("a url still plans cloneUserRepo", () => {
      const plan = buildInitPlan(freshState(), { url: "https://x/a.git", machineKey: "m" });
      expect(plan.steps.some((s) => s.kind === "cloneUserRepo")).toBe(true);
    });

    test("gitignore and owners ride along with initUserRepo, same as clone", () => {
      const plan = buildInitPlan(freshState(), { url: null, machineKey: "m" });
      expect(plan.steps.some((s) => s.kind === "writeGitignore")).toBe(true);
      expect(plan.steps.some((s) => s.kind === "writeOwners")).toBe(true);
    });

    test("an existing repo is never re-initialised, with or without a url", () => {
      const present = { ...freshState(), userRepoPresent: true };
      for (const url of [null, "https://x/a.git"]) {
        const plan = buildInitPlan(present, { url, machineKey: "m" });
        expect(plan.steps.some((s) => s.kind === "initUserRepo" || s.kind === "cloneUserRepo")).toBe(false);
      }
    });

    test("commitInitialUserRepo is planned only on the local-only path, after writeGitignore/writeOwners", () => {
      const plan = buildInitPlan(freshState(), { url: null, machineKey: "m" });
      const kinds = plan.steps.map((s) => s.kind);
      expect(kinds).toContain("commitInitialUserRepo");
      expect(kinds.indexOf("commitInitialUserRepo")).toBeGreaterThan(kinds.indexOf("writeGitignore"));
      expect(kinds.indexOf("commitInitialUserRepo")).toBeGreaterThan(kinds.indexOf("writeOwners"));
    });

    test("a url plans no commitInitialUserRepo step — a clone already has history", () => {
      const plan = buildInitPlan(freshState(), { url: "https://x/a.git", machineKey: "m" });
      expect(plan.steps.some((s) => s.kind === "commitInitialUserRepo")).toBe(false);
    });
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

describe("chooseMachineProfile", () => {
  const BASE: ChooseMachineProfileInput = {
    profiles: [],
    hostnameSlug: "mbp-14",
    flags: {},
    interactive: false,
  };

  test("zero profiles, no flags: falls back to the hostname slug regardless of interactivity", () => {
    expect(chooseMachineProfile({ ...BASE, interactive: false })).toEqual({ key: "mbp-14", source: "hostname" });
    expect(chooseMachineProfile({ ...BASE, interactive: true })).toEqual({ key: "mbp-14", source: "hostname" });
  });

  test("--profile naming an existing profile: adopts it, source 'existing'", () => {
    const result = chooseMachineProfile({ ...BASE, profiles: ["desktop", "laptop"], flags: { profile: "laptop" } });
    expect(result).toEqual({ key: "laptop", source: "existing" });
  });

  test("--profile naming a non-existent profile without --new-profile: throws, names the flag and the existing profiles", () => {
    expect(() =>
      chooseMachineProfile({ ...BASE, profiles: ["desktop"], flags: { profile: "new-box" } }),
    ).toThrow(UnknownProfileFlagError);
    try {
      chooseMachineProfile({ ...BASE, profiles: ["desktop"], flags: { profile: "new-box" } });
    } catch (err) {
      expect((err as Error).message).toContain("new-box");
      expect((err as Error).message).toContain("desktop");
      expect((err as Error).message).toContain("--new-profile");
    }
  });

  test("--profile + --new-profile naming a NEW key: creates it, source 'flag'", () => {
    const result = chooseMachineProfile({
      ...BASE,
      profiles: ["desktop"],
      flags: { profile: "new-box", newProfile: true },
    });
    expect(result).toEqual({ key: "new-box", source: "flag" });
  });

  test("bare --new-profile (no --profile): uses the hostname slug, source 'flag'", () => {
    const result = chooseMachineProfile({ ...BASE, profiles: ["desktop"], flags: { newProfile: true } });
    expect(result).toEqual({ key: "mbp-14", source: "flag" });
  });

  test("--profile <existing> --new-profile: adopts the existing profile (existing-match wins over the new-profile flag — deliberate ordering)", () => {
    const result = chooseMachineProfile({
      ...BASE,
      profiles: ["desktop"],
      flags: { profile: "desktop", newProfile: true },
    });
    expect(result).toEqual({ key: "desktop", source: "existing" });
  });

  test("bare --new-profile whose default hostname-slug name collides with an EXISTING profile: throws, never silently shares that profile", () => {
    expect(() =>
      chooseMachineProfile({ ...BASE, hostnameSlug: "mbp-14", profiles: ["mbp-14", "desktop"], flags: { newProfile: true } }),
    ).toThrow(ProfileNameCollisionError);
    try {
      chooseMachineProfile({ ...BASE, hostnameSlug: "mbp-14", profiles: ["mbp-14", "desktop"], flags: { newProfile: true } });
    } catch (err) {
      expect((err as Error).message).toContain("mbp-14");
      expect((err as Error).message).toContain("--profile");
    }
  });

  test("--profile <name> --new-profile with a name that collides with an existing profile: adopts it instead of colliding (an explicit name always resolves to 'existing', never the collision error)", () => {
    const result = chooseMachineProfile({
      ...BASE,
      hostnameSlug: "mbp-14",
      profiles: ["mbp-14", "desktop"],
      flags: { profile: "mbp-14", newProfile: true },
    });
    expect(result).toEqual({ key: "mbp-14", source: "existing" });
  });

  test("exactly one profile matching this machine's own hostname slug, non-interactive: adopts it — a partial install's retry (or the app's own first launch) created it moments earlier", () => {
    const result = chooseMachineProfile({ ...BASE, hostnameSlug: "mbp-14", profiles: ["mbp-14"], interactive: false });
    expect(result).toEqual({ key: "mbp-14", source: "existing" });
  });

  test("exactly one profile NOT matching the hostname slug, non-interactive: still throws — adopting another machine's profile is never a silent default", () => {
    expect(() => chooseMachineProfile({ ...BASE, hostnameSlug: "mbp-14", profiles: ["desktop"], interactive: false })).toThrow(
      ProfileChoiceRequiredError,
    );
  });

  test("existing profiles, no flags, non-interactive: throws, directs to --profile/--new-profile", () => {
    expect(() => chooseMachineProfile({ ...BASE, profiles: ["desktop", "laptop"], interactive: false })).toThrow(
      ProfileChoiceRequiredError,
    );
    try {
      chooseMachineProfile({ ...BASE, profiles: ["desktop", "laptop"], interactive: false });
    } catch (err) {
      expect((err as Error).message).toContain("--profile");
      expect((err as Error).message).toContain("--new-profile");
      expect((err as Error).message).toContain("desktop");
    }
  });

  test("existing profiles, no flags, interactive: hands back 'prompt-needed' rather than picking itself", () => {
    const result = chooseMachineProfile({ ...BASE, profiles: ["desktop", "laptop"], interactive: true });
    expect(result).toEqual({ key: "", source: "prompt-needed" });
  });

  test.each([
    ["empty", ""],
    ["exactly \".\"", "."],
    ["exactly \"..\"", ".."],
    ["a forward slash", "evil/key"],
    ["a backslash", "evil\\key"],
  ])("unsafe --profile + --new-profile key (%s): throws InvalidProfileKeyError", (_label, badKey) => {
    expect(() =>
      chooseMachineProfile({ ...BASE, profiles: [], flags: { profile: badKey, newProfile: true } }),
    ).toThrow(InvalidProfileKeyError);
  });

  test("unsafe hostname slug (defensive — machineKey() itself never produces one): throws InvalidProfileKeyError", () => {
    expect(() => chooseMachineProfile({ ...BASE, hostnameSlug: "../escape", profiles: [] })).toThrow(
      InvalidProfileKeyError,
    );
  });
});
