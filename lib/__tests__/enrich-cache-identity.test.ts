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
import { createCacheHandlers } from "../daemon/handlers/cache.ts";
import { fakeStore } from "../daemon/__tests__/fake-cache-store.ts";

// Captured before any mock.module call... mock.module mutates the live
// namespace object in place, so restoring with the ORIGINAL binding (not a
// re-import) is what undoes it for every other test file sharing this process.
const realDaemonClient = await import("../daemon-client.ts");
const realDaemonQuery = realDaemonClient.daemonQuery;

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "rt-enrich-identity-"));
  process.env.HOME = home;
  spyOn(linearModule, "loadSecrets").mockResolvedValue({ linearApiKey: undefined, gitlabToken: undefined } as any);
});

afterEach(() => {
  mock.module("../daemon-client.ts", () => ({
    ...realDaemonClient,
    daemonQuery: realDaemonQuery,
  }));
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

describe("enrichBranches daemon-first path: cache:read is repo-scoped", () => {
  test("two tracked repos both have branch 'main': a repoIdentity-scoped read returns repo A's entry, never repo B's", async () => {
    const identityA = "remote:gitlab.com%2Facme%2Frepo-a";
    const identityB = "remote:gitlab.com%2Facme%2Frepo-b";
    const entries: Record<string, any> = {
      [composeKey(identityA, "main")]: {
        linearId: "A-1", ticket: null, mr: null, fetchedAt: Date.now(), repoName: identityA,
      },
      [composeKey(identityB, "main")]: {
        linearId: "B-1", ticket: null, mr: null, fetchedAt: Date.now(), repoName: identityB,
      },
    };
    // The real cache:read handler over an in-memory store: this exercises the
    // actual scoping logic, not a stand-in for it.
    const handlers = createCacheHandlers({
      cache: fakeStore(entries),
      refreshCache: async () => {},
    } as any);

    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
      daemonQuery: async (cmd: string, payload: any) => {
        if (cmd !== "cache:read") throw new Error(`unexpected daemon command: ${cmd}`);
        return handlers["cache:read"]!(payload);
      },
    }));

    const result = await enrichBranches(
      [{ path: "/tmp/repo-a", branch: "main" }],
      "git@gitlab.com:acme/repo-a.git",
    );

    expect(result[0]?.linearId).toBe("A-1");
  });
});
