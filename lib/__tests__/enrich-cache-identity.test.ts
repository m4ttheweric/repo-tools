/**
 * lib/enrich.ts: cold-start writes are keyed by the composite
 * `${identity}:${branch}` (S069/Task 10), not the bare branch. Without this,
 * two repos enriching a same-named branch overwrite each other's cache row.
 *
 * `loadSecrets` is mocked to report no API keys, so `fetchAndCache` never
 * reaches GitLab/Linear; it still writes a cache row per branch (mr/ticket
 * null), which is all this test needs to observe the key format.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as linearModule from "../linear.ts";
import { enrichBranches } from "../enrich.ts";
import { closeStateDb, getBranchCacheStore } from "../state/index.ts";
import { composeKey } from "../state/branch-cache.ts";

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-enrich-identity-"));
  process.env.HOME = home;
  spyOn(linearModule, "loadSecrets").mockResolvedValue({ linearApiKey: undefined, gitlabToken: undefined } as any);
});

afterEach(() => {
  mock.restore();
  closeStateDb();
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("enrichBranches cold-start: repoName/key is the serialized remote identity", () => {
  test("writes the cache row under composeKey(identity, branch), not the bare branch", async () => {
    await enrichBranches(
      [{ path: "/tmp/repo-a", branch: "main" }],
      "git@gitlab.com:acme/repo-a.git",
      { silent: true },
    );

    const entries = getBranchCacheStore().entries;
    const identityKeys = Object.keys(entries).filter((k) => k.endsWith(":main"));
    expect(identityKeys.length).toBe(1);
    expect(entries["main"]).toBeUndefined(); // never the bare branch
    expect(entries[identityKeys[0]!]?.repoName).toBe(identityKeys[0]!.replace(/:main$/, ""));
  });

  test("two repos enriching the same branch name coexist (no collision)", async () => {
    await enrichBranches(
      [{ path: "/tmp/repo-a", branch: "main" }],
      "git@gitlab.com:acme/repo-a.git",
      { silent: true },
    );
    await enrichBranches(
      [{ path: "/tmp/repo-b", branch: "main" }],
      "git@gitlab.com:acme/repo-b.git",
      { silent: true },
    );

    const entries = getBranchCacheStore().entries;
    const keyA = composeKey("remote:gitlab.com%2Facme%2Frepo-a", "main");
    const keyB = composeKey("remote:gitlab.com%2Facme%2Frepo-b", "main");
    expect(entries[keyA]).toBeDefined();
    expect(entries[keyB]).toBeDefined();
    expect(entries[keyA]).not.toBe(entries[keyB]);
  });

  test("no remote (path-only repo) degrades to a bare-branch key", async () => {
    await enrichBranches(
      [{ path: "/tmp/repo-local", branch: "scratch" }],
      undefined,
      { silent: true },
    );

    const entries = getBranchCacheStore().entries;
    expect(entries["scratch"]).toBeDefined();
    expect(entries["scratch"]?.repoName).toBeUndefined();
  });
});
