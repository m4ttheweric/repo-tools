import { describe, test, expect } from "bun:test";
import type { MRDashboardProps } from "@mattstack/glance";
import { canRebaseRemotely, behindSuffix } from "../format.ts";

/** Minimal MR stand-in: these helpers only read state, rebaseButton, behindTarget. */
function mr(opts: {
  state?: MRDashboardProps["state"];
  required?: boolean;
  behindTarget?: number | null;
}): MRDashboardProps {
  return {
    state: opts.state ?? "opened",
    rebaseButton: { visible: opts.required ?? false, loading: false, label: "Rebase" },
    behindTarget: opts.behindTarget ?? null,
  } as MRDashboardProps;
}

describe("canRebaseRemotely", () => {
  test("GitLab requires a rebase", () => {
    expect(canRebaseRemotely(mr({ required: true }))).toBe(true);
  });

  test("not required but known to be behind — still offer it", () => {
    expect(canRebaseRemotely(mr({ required: false, behindTarget: 3 }))).toBe(true);
  });

  test("not required and up to date", () => {
    expect(canRebaseRemotely(mr({ required: false, behindTarget: 0 }))).toBe(false);
  });

  // The MAT-164 bug: an unfetched count read as "up to date". Null must not
  // manufacture an affordance, and must never hide one GitLab is demanding.
  test("unknown behind-ness alone offers nothing", () => {
    expect(canRebaseRemotely(mr({ required: false, behindTarget: null }))).toBe(false);
  });

  test("unknown behind-ness never suppresses a required rebase", () => {
    expect(canRebaseRemotely(mr({ required: true, behindTarget: null }))).toBe(true);
  });

  test("closed and merged MRs are never rebaseable", () => {
    expect(canRebaseRemotely(mr({ state: "merged", required: true, behindTarget: 9 }))).toBe(false);
    expect(canRebaseRemotely(mr({ state: "closed", required: true, behindTarget: 9 }))).toBe(false);
  });
});

describe("behindSuffix", () => {
  test("known and behind", () => expect(behindSuffix(mr({ behindTarget: 12 }))).toBe(" (12 behind)"));
  test("known and current", () => expect(behindSuffix(mr({ behindTarget: 0 }))).toBe(""));
  test("unknown says nothing rather than zero", () =>
    expect(behindSuffix(mr({ behindTarget: null }))).toBe(""));
});
