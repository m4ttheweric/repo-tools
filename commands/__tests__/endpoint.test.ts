import { describe, expect, test } from "bun:test";
import { parseEndpointReleaseArgs } from "../endpoint.ts";

describe("parseEndpointReleaseArgs", () => {
  test("worktree first, no role", () => {
    expect(parseEndpointReleaseArgs(["/path/wt"])).toEqual({ worktree: "/path/wt", role: undefined, roleInvalid: false });
  });

  test("--json before the worktree, no role", () => {
    expect(parseEndpointReleaseArgs(["--json", "/path/wt"])).toEqual({ worktree: "/path/wt", role: undefined, roleInvalid: false });
  });

  test("worktree then --role", () => {
    expect(parseEndpointReleaseArgs(["/path/wt", "--role", "web"])).toEqual({ worktree: "/path/wt", role: "web", roleInvalid: false });
  });

  test("--role before the worktree", () => {
    expect(parseEndpointReleaseArgs(["--role", "web", "/path/wt"])).toEqual({ worktree: "/path/wt", role: "web", roleInvalid: false });
  });

  test("--role with no following value is flagged invalid, not treated as omitted", () => {
    expect(parseEndpointReleaseArgs(["/path/wt", "--role"])).toEqual({
      worktree: "/path/wt",
      role: undefined,
      roleInvalid: true,
    });
  });

  test("--role followed by --json (option-like) is flagged invalid, not treated as a role value", () => {
    expect(parseEndpointReleaseArgs(["/path/wt", "--role", "--json"])).toEqual({
      worktree: "/path/wt",
      role: undefined,
      roleInvalid: true,
    });
  });
});
