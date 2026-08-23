/**
 * lib/state/endpoint-claims-store.ts — endpoint_claims: one row per
 * (repo, worktree, role).
 *
 * HOME isolation is handled by the repo-wide bun test preload
 * (test-setup.ts) — never removed here. Stores are constructed via
 * openStateDb(tempPath) per the house convention.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { type EndpointClaim, listEndpointClaims, replaceEndpointClaims } from "../endpoint-claims-store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-endpoint-claims-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): Database {
  return openStateDb(join(dir, "state.db"), "cli");
}

function claim(overrides: Partial<EndpointClaim> = {}): EndpointClaim {
  return { worktree: "/repo/main", role: "web", port: 3000, ts: "2026-08-22T00:00:00Z", ...overrides };
}

describe("listEndpointClaims / replaceEndpointClaims", () => {
  test("an unclaimed repo has no rows", () => {
    const db = openDb();
    expect(listEndpointClaims("repo-a", db)).toEqual([]);
  });

  test("replace persists and list round-trips, including an optional pid", () => {
    const db = openDb();
    const c = claim({ pid: 4242 });
    replaceEndpointClaims("repo-a", [c], db);
    expect(listEndpointClaims("repo-a", db)).toEqual([c]);
  });

  test("a claim with no pid round-trips without one (not null, not 0)", () => {
    const db = openDb();
    const c = claim();
    replaceEndpointClaims("repo-a", [c], db);
    const [got] = listEndpointClaims("repo-a", db);
    expect(got).toEqual(c);
    expect("pid" in got!).toBe(false);
  });

  test("replace fully swaps the set: an old claim not in the new list is gone", () => {
    const db = openDb();
    replaceEndpointClaims("repo-a", [claim({ worktree: "/repo/wt1", role: "web", port: 3000 })], db);
    replaceEndpointClaims("repo-a", [claim({ worktree: "/repo/wt2", role: "api", port: 4000 })], db);
    expect(listEndpointClaims("repo-a", db)).toEqual([claim({ worktree: "/repo/wt2", role: "api", port: 4000 })]);
  });

  test("replace with an empty array clears the repo's claims", () => {
    const db = openDb();
    replaceEndpointClaims("repo-a", [claim()], db);
    replaceEndpointClaims("repo-a", [], db);
    expect(listEndpointClaims("repo-a", db)).toEqual([]);
  });

  test("claims for one repo do not leak into another repo's list", () => {
    const db = openDb();
    replaceEndpointClaims("repo-a", [claim()], db);
    expect(listEndpointClaims("repo-b", db)).toEqual([]);
  });

  test("replacing repo-a's claims does not touch repo-b's", () => {
    const db = openDb();
    replaceEndpointClaims("repo-a", [claim({ worktree: "/a" })], db);
    replaceEndpointClaims("repo-b", [claim({ worktree: "/b" })], db);
    replaceEndpointClaims("repo-a", [], db);
    expect(listEndpointClaims("repo-a", db)).toEqual([]);
    expect(listEndpointClaims("repo-b", db)).toEqual([claim({ worktree: "/b" })]);
  });

  test("multiple worktree+role claims coexist for one repo, listed ordered", () => {
    const db = openDb();
    replaceEndpointClaims(
      "repo-a",
      [claim({ worktree: "/repo/wt2", role: "web" }), claim({ worktree: "/repo/wt1", role: "web" })],
      db,
    );
    expect(listEndpointClaims("repo-a", db).map((c) => c.worktree)).toEqual(["/repo/wt1", "/repo/wt2"]);
  });

  test("a fresh handle on the same file sees the last write (daemon restart)", () => {
    const dbPath = join(dir, "state.db");
    const db1 = openStateDb(dbPath, "cli");
    replaceEndpointClaims("repo-a", [claim()], db1);
    db1.close();

    const db2 = openStateDb(dbPath, "cli");
    expect(listEndpointClaims("repo-a", db2)).toEqual([claim()]);
    db2.close();
  });
});
