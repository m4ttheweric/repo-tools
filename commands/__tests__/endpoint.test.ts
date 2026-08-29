import { describe, expect, test } from "bun:test";
import { parseEndpointReleaseArgs } from "../endpoint.ts";

describe("parseEndpointReleaseArgs", () => {
  test("worktree first, no role", () => {
    expect(parseEndpointReleaseArgs(["/path/wt"])).toEqual({ worktree: "/path/wt", role: undefined });
  });

  test("--json before the worktree, no role", () => {
    expect(parseEndpointReleaseArgs(["--json", "/path/wt"])).toEqual({ worktree: "/path/wt", role: undefined });
  });

  test("worktree then --role", () => {
    expect(parseEndpointReleaseArgs(["/path/wt", "--role", "web"])).toEqual({ worktree: "/path/wt", role: "web" });
  });

  test("--role before the worktree", () => {
    expect(parseEndpointReleaseArgs(["--role", "web", "/path/wt"])).toEqual({ worktree: "/path/wt", role: "web" });
  });
});
