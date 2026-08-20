import { describe, test, expect } from "bun:test";
import { gatherHomeState, type HomeProbes } from "../home.ts";
import { buildInitPlan } from "../../lib/home/init-plan.ts";

function fakeProbes(overrides: Partial<HomeProbes>): HomeProbes {
  return {
    isGitRepo: () => false,
    exists: () => false,
    listTeamClones: () => [],
    ...overrides,
  };
}

describe("gatherHomeState", () => {
  test("hasUserClone is true only when user/ is itself a git clone", () => {
    const probes = fakeProbes({
      isGitRepo: (dir) => dir.endsWith("/user"),
    });
    const state = gatherHomeState("/home", probes);
    expect(state.hasUserClone).toBe(true);
  });

  test("a plain (non-git) user/ directory does not count as a clone, and yields no foldInPrefs step", () => {
    const probes = fakeProbes({
      // user/ exists on disk but isn't a git repo — e.g. a half-materialized
      // or manually-created directory, not the mattstack-prefs clone.
      exists: (path) => path.endsWith("/user"),
      isGitRepo: () => false,
    });
    const state = gatherHomeState("/home", probes);
    expect(state.hasUserClone).toBe(false);

    const plan = buildInitPlan(state);
    expect(plan.steps.map((s) => s.kind)).not.toContain("foldInPrefs");
  });
});
