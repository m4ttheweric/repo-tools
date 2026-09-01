/**
 * Pure arg-parsing tests for the `rt worktree` CLI verbs. Daemon-path
 * behavior (provision/create/dispose/list/freshen/adopt actually talking to
 * the daemon) is covered by Task 13's handler tests — this file only checks
 * that raw CLI args are sliced into the right payload shape.
 */
import { describe, expect, test } from "bun:test";
import {
  parseProvisionArgs,
  parseCreateArgs,
  parseDisposeArgs,
  parseListArgs,
  parseFreshenArgs,
  parseAdoptArgs,
} from "../../commands/worktree.ts";

describe("parseProvisionArgs", () => {
  test("bare --ticket", () => {
    expect(parseProvisionArgs(["--ticket", "RT-40"])).toEqual({
      repoName: undefined, ticket: "RT-40", title: undefined, branch: undefined,
      owner: undefined, disposal: undefined, wait: false, json: false,
    });
  });
  test("--ticket with --title", () => {
    const r = parseProvisionArgs(["--ticket", "RT-40", "--title", "Prune verbs"]);
    expect(r.ticket).toBe("RT-40");
    expect(r.title).toBe("Prune verbs");
  });
  test("--branch takes precedence path is left to the caller — both parsed", () => {
    const r = parseProvisionArgs(["--branch", "feature/x", "--repo", "repo-tools"]);
    expect(r.branch).toBe("feature/x");
    expect(r.repoName).toBe("repo-tools");
  });
  test("--owner, --disposal, --json all parsed", () => {
    const r = parseProvisionArgs(["--ticket", "RT-1", "--owner", "matt", "--disposal", "job", "--json"]);
    expect(r.owner).toBe("matt");
    expect(r.disposal).toBe("job");
    expect(r.json).toBe(true);
  });
  test("no flags → all undefined, json false", () => {
    expect(parseProvisionArgs([])).toEqual({
      repoName: undefined, ticket: undefined, title: undefined, branch: undefined,
      owner: undefined, disposal: undefined, wait: false, json: false,
    });
  });
});

describe("parseCreateArgs", () => {
  test("defaults", () => {
    expect(parseCreateArgs([])).toEqual({ repoName: undefined, onDeck: false, json: false });
  });
  test("--repo, --on-deck, --json", () => {
    expect(parseCreateArgs(["--repo", "repo-tools", "--on-deck", "--json"])).toEqual({
      repoName: "repo-tools", onDeck: true, json: true,
    });
  });
});

describe("parseDisposeArgs", () => {
  test("positional tree name", () => {
    const r = parseDisposeArgs(["my-tree"]);
    expect(r.tree).toBe("my-tree");
    expect(r.owner).toBeUndefined();
    expect(r.force).toBe(false);
  });
  test("--owner sweep, no positional", () => {
    const r = parseDisposeArgs(["--owner", "matt"]);
    expect(r.tree).toBeUndefined();
    expect(r.owner).toBe("matt");
  });
  test("tree + --repo + --force + --json", () => {
    const r = parseDisposeArgs(["my-tree", "--repo", "repo-tools", "--force", "--json"]);
    expect(r).toEqual({ tree: "my-tree", owner: undefined, repoName: "repo-tools", force: true, json: true });
  });
  test("no args at all", () => {
    const r = parseDisposeArgs([]);
    expect(r.tree).toBeUndefined();
    expect(r.owner).toBeUndefined();
    expect(r.force).toBe(false);
    expect(r.json).toBe(false);
  });
});

describe("parseListArgs", () => {
  test("defaults", () => {
    expect(parseListArgs([])).toEqual({ repoName: undefined, json: false });
  });
  test("--repo + --json", () => {
    expect(parseListArgs(["--repo", "repo-tools", "--json"])).toEqual({ repoName: "repo-tools", json: true });
  });
});

describe("parseFreshenArgs", () => {
  test("positional tree only", () => {
    const r = parseFreshenArgs(["my-tree"]);
    expect(r.tree).toBe("my-tree");
  });
  test("no args", () => {
    expect(parseFreshenArgs([])).toEqual({ tree: undefined, repoName: undefined, json: false });
  });
  test("tree + --repo + --json", () => {
    expect(parseFreshenArgs(["my-tree", "--repo", "repo-tools", "--json"])).toEqual({
      tree: "my-tree", repoName: "repo-tools", json: true,
    });
  });
});

describe("parseAdoptArgs", () => {
  test("--repo required, --json and --claim optional", () => {
    expect(parseAdoptArgs(["--repo", "repo-tools"])).toEqual({ repoName: "repo-tools", json: false, claim: false });
    expect(parseAdoptArgs(["--repo", "repo-tools", "--json"])).toEqual({ repoName: "repo-tools", json: true, claim: false });
  });
  test("no --repo → repoName undefined (caller decides how to fail)", () => {
    expect(parseAdoptArgs([])).toEqual({ repoName: undefined, json: false, claim: false });
  });
  test("--claim opts a foreign tree into ephemeral ownership", () => {
    expect(parseAdoptArgs(["--repo", "repo-tools", "--claim"])).toEqual({ repoName: "repo-tools", json: false, claim: true });
  });
});
