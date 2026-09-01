import { describe, test, expect } from "bun:test";
import { pathParam, repoPathParam, splitRepoAndRest } from "../api-server.ts";

describe("pathParam", () => {
  test("decodes a clean prefix-only param", () => {
    expect(pathParam("/api/cache/main", "/api/cache/")).toBe("main");
  });

  test("decodes a URL-encoded segment", () => {
    expect(pathParam("/api/cache/feature%2Ffoo", "/api/cache/")).toBe("feature/foo");
  });

  test("returns undefined for malformed %-encoding instead of throwing", () => {
    expect(pathParam("/api/cache/%E0%A4%A", "/api/cache/")).toBeUndefined();
  });

  test("returns undefined when the pathname doesn't start with the prefix", () => {
    expect(pathParam("/api/other/main", "/api/cache/")).toBeUndefined();
  });

  test("handles a prefix+suffix pair (hooks repair shape)", () => {
    expect(pathParam("/api/hooks/my-repo/repair", "/api/hooks/", "/repair")).toBe("my-repo");
  });

  test("prefix+suffix: malformed encoding still returns undefined", () => {
    expect(pathParam("/api/hooks/%E0%A4%A/repair", "/api/hooks/", "/repair")).toBeUndefined();
  });

  test("prefix+suffix: wrong suffix returns undefined", () => {
    expect(pathParam("/api/hooks/my-repo/other", "/api/hooks/", "/repair")).toBeUndefined();
  });

  test("an empty captured segment returns undefined", () => {
    expect(pathParam("/api/cache/", "/api/cache/")).toBeUndefined();
  });
});

// A serialized identity is ALREADY one slash-free segment — that is what
// serializeIdentity's percent-encoding buys (see its docblock). Decoding it
// turns its %2F back into route separators, which silently destroyed the key:
// hooks:repair refused the non-canonical string and answered ok/no-op, and
// runs:get split the repo in half.
const WIRE = "remote:github.com%2Fm4ttheweric%2Fskills";

describe("repoPathParam", () => {
  test("hands back a canonical wire undecoded", () => {
    expect(repoPathParam(`/api/hooks/${WIRE}/repair`, "/api/hooks/", "/repair")).toBe(WIRE);
  });

  test("still decodes a legacy plain name", () => {
    expect(repoPathParam("/api/hooks/my-repo/repair", "/api/hooks/", "/repair")).toBe("my-repo");
  });

  test("accepts a client that re-encoded the wire anyway", () => {
    expect(repoPathParam(`/api/hooks/${encodeURIComponent(WIRE)}/repair`, "/api/hooks/", "/repair")).toBe(WIRE);
  });

  test("malformed %-encoding still returns undefined", () => {
    expect(repoPathParam("/api/hooks/%E0%A4%A/repair", "/api/hooks/", "/repair")).toBeUndefined();
  });

  test("wrong suffix returns undefined", () => {
    expect(repoPathParam(`/api/hooks/${WIRE}/other`, "/api/hooks/", "/repair")).toBeUndefined();
  });
});

describe("splitRepoAndRest", () => {
  test("keeps a wire repo whole and returns the trailing id", () => {
    expect(splitRepoAndRest(`/api/runs/${WIRE}/RUN-42`, "/api/runs/")).toEqual({ repo: WIRE, rest: "RUN-42" });
  });

  test("splits a legacy plain name the same way", () => {
    expect(splitRepoAndRest("/api/runs/e2e-repo/RUN-1", "/api/runs/")).toEqual({ repo: "e2e-repo", rest: "RUN-1" });
  });

  test("decodes the trailing id", () => {
    expect(splitRepoAndRest(`/api/runs/${WIRE}/RUN%2042`, "/api/runs/")).toEqual({ repo: WIRE, rest: "RUN 42" });
  });

  test("returns undefined without both segments, so the caller can 404", () => {
    expect(splitRepoAndRest("/api/runs/onlyonesegment", "/api/runs/")).toBeUndefined();
    expect(splitRepoAndRest(`/api/runs/${WIRE}/`, "/api/runs/")).toBeUndefined();
  });

  test("reports malformed %-encoding separately, so the caller can 400", () => {
    expect(splitRepoAndRest("/api/runs/e2e-repo/%E0%A4%A", "/api/runs/")).toBe("malformed");
  });
});
