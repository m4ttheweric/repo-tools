import { describe, expect, test } from "bun:test";
import { validateChain } from "../chain.ts";
import type { StageEntry } from "../types.ts";

const SEED = ["work-type", "ticket", "repo", "mode"];
const e = (name: string, consumes: string[], produces: string[]): StageEntry =>
  ({ name, stage: name.replace(/^stage-/, ""), dir: `x/${name}`, consumes, produces });

describe("validateChain", () => {
  test("a sound chain has no errors", () => {
    expect(validateChain("feature", [
      e("stage-provision", ["ticket", "repo"], ["branch", "worktree"]),
      e("stage-plan", ["ticket"], ["approach"]),
      e("stage-implement", ["approach", "branch", "worktree"], ["commits"]),
    ], SEED)).toEqual([]);
  });

  test("a consumer with no earlier producer is named", () => {
    expect(validateChain("feature", [
      e("stage-plan", ["ticket"], ["approach"]),
      e("stage-ship", ["commits", "ticket"], ["mr"]),
    ], SEED)).toEqual([
      'pipeline "feature": stage "stage-ship" consumes "commits" but no earlier stage produces it and it is not in the seed',
    ]);
  });

  test("order matters: producing later does not satisfy an earlier consumer", () => {
    expect(validateChain("feature", [
      e("stage-ship", ["commits"], ["mr"]),
      e("stage-implement", [], ["commits"]),
    ], SEED)).toHaveLength(1);
  });
});
