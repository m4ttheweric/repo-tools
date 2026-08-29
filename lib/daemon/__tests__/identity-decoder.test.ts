/**
 * decodeRepo: the one guard every repo-keyed handler in worktree.ts,
 * repos.ts and endpoint.ts used to inline as `parseIdentity(x) === null`.
 * Covers both wire fields those handlers read today ("repoName" for the
 * worktree commands, "repo" for the endpoint and repos-locate commands)
 * since decodeRepo has to serve both without either caller changing what
 * it sends.
 */

import { describe, expect, test } from "bun:test";
import { serializeIdentity } from "../../settings/identity.ts";
import { decodeRepo } from "../identity-decoder.ts";

describe("decodeRepo", () => {
  test("rejects a bare display name under the repoName field", () => {
    const result = decodeRepo({ repoName: "bad" });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe("repo-unknown");
  });

  test("rejects a bare display name under the repo field", () => {
    const result = decodeRepo({ repo: "bad" });
    expect(result.ok).toBe(false);
  });

  test("rejects a missing repo field", () => {
    const result = decodeRepo({});
    expect(result.ok).toBe(false);
  });

  test("rejects a non-string repo field", () => {
    const result = decodeRepo({ repoName: 42 });
    expect(result.ok).toBe(false);
  });

  test("accepts a valid serialized identity under repoName and returns the branded value", () => {
    const wire = serializeIdentity({ kind: "path", id: "/Users/matt/repo" });
    const result = decodeRepo({ repoName: wire });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; repo: string }).repo).toBe(wire);
  });

  test("accepts a valid serialized identity under repo and returns the branded value", () => {
    const wire = serializeIdentity({ kind: "remote", id: "gitlab.com/acme/acme-dev" });
    const result = decodeRepo({ repo: wire });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; repo: string }).repo).toBe(wire);
  });

  test("prefers repoName over repo when a payload somehow carries both", () => {
    const wire = serializeIdentity({ kind: "path", id: "/Users/matt/repo" });
    const result = decodeRepo({ repoName: wire, repo: "bad" });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; repo: string }).repo).toBe(wire);
  });
});
