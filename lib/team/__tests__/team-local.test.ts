import { describe, expect, test } from "bun:test";
import { readTeamLocal, teamLocalPath, updateTeamLocal, writeTeamLocal } from "../team-local.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";

const HOME = "/fake-home";
const SLUG = "acme";

describe("team-local record", () => {
  test("absent record reads as all-false — a permission never granted is not held", () => {
    const p = fakeProbes({ home: HOME });
    expect(readTeamLocal(p, SLUG)).toEqual({ createdByRt: false, joinedByRt: false, rtMayManageMembership: false });
  });

  // The whole point of the default: every team predating this file — including
  // one whose remote is an employer's repo — is off with no migration step.
  test("malformed JSON reads as all-false rather than throwing", () => {
    const p = fakeProbes({ home: HOME, files: { [teamLocalPath(HOME, SLUG)]: "{not json" } });
    expect(readTeamLocal(p, SLUG)).toEqual({ createdByRt: false, joinedByRt: false, rtMayManageMembership: false });
  });

  test("a non-boolean permission value is not truthy-coerced into a grant", () => {
    const p = fakeProbes({ home: HOME, files: { [teamLocalPath(HOME, SLUG)]: JSON.stringify({ rtMayManageMembership: "yes" }) } });
    expect(readTeamLocal(p, SLUG).rtMayManageMembership).toBe(false);
  });

  test("round-trips a granted permission", () => {
    const p = fakeProbes({ home: HOME });
    writeTeamLocal(p, SLUG, { createdByRt: true, joinedByRt: false, rtMayManageMembership: true });
    expect(readTeamLocal(p, SLUG)).toEqual({ createdByRt: true, joinedByRt: false, rtMayManageMembership: true });
  });

  test("updateTeamLocal merges without clobbering the other field", () => {
    const p = fakeProbes({ home: HOME });
    updateTeamLocal(p, SLUG, { createdByRt: true });
    updateTeamLocal(p, SLUG, { rtMayManageMembership: true });
    expect(readTeamLocal(p, SLUG)).toEqual({ createdByRt: true, joinedByRt: false, rtMayManageMembership: true });
  });

  test("records are per-team — granting one team says nothing about another", () => {
    const p = fakeProbes({ home: HOME });
    updateTeamLocal(p, SLUG, { rtMayManageMembership: true });
    expect(readTeamLocal(p, "other-team").rtMayManageMembership).toBe(false);
  });

  test("joinedByRt defaults to false and round-trips", () => {
    const p = fakeProbes({ home: HOME });
    expect(readTeamLocal(p, SLUG).joinedByRt).toBe(false);
    updateTeamLocal(p, SLUG, { joinedByRt: true });
    expect(readTeamLocal(p, SLUG)).toEqual({ createdByRt: false, joinedByRt: true, rtMayManageMembership: false });
  });

  test("a non-boolean joinedByRt is not truthy-coerced", () => {
    const p = fakeProbes({ home: HOME, files: { [teamLocalPath(HOME, SLUG)]: JSON.stringify({ joinedByRt: "yes" }) } });
    expect(readTeamLocal(p, SLUG).joinedByRt).toBe(false);
  });

  // Local by construction: nothing in the team repo can set this, because it
  // is not read from there. A synced flag would let a team's author turn on a
  // privileged capability on a member's machine.
  test("the record lives under ~/.mattstack/rt, not in the team clone", () => {
    expect(teamLocalPath(HOME, SLUG)).toBe(`${HOME}/.mattstack/rt/teams/${SLUG}.json`);
    expect(teamLocalPath(HOME, SLUG)).not.toContain("/teams/acme/.git");
  });
});
