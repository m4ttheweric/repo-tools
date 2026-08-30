/**
 * repo-cache: the cd-cache read/write module rt cd's repo list is served
 * from. Round-trip plus every null-return path (missing, corrupt, wrong
 * version) must never throw, and the atomic write must never leave a
 * partial file a concurrent reader could observe.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { cdCachePath } from "../rt-paths.ts";
import { readRepoCache, writeRepoCache } from "../repo-cache.ts";
import type { KnownRepo } from "../repo-index.ts";

describe("repo-cache", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-repo-cache-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  const sampleRepos: KnownRepo[] = [
    { repoName: "repo-tools", worktrees: [{ path: "/repos/repo-tools", branch: "main", isBare: false }], dataDir: "/data/repo-tools" },
  ];

  test("round-trips a valid payload", () => {
    writeRepoCache(sampleRepos);

    const result = readRepoCache();

    expect(result).not.toBeNull();
    expect(result?.repos).toEqual(sampleRepos);
    expect(typeof result?.builtAt).toBe("number");
  });

  test("returns null when the cache file is missing", () => {
    expect(readRepoCache()).toBeNull();
  });

  test("returns null on corrupt JSON", () => {
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    writeFileSync(cdCachePath(), "{ not valid json");

    expect(readRepoCache()).toBeNull();
  });

  test("returns null when version is not 1", () => {
    mkdirSync(join(home, ".mattstack", "rt"), { recursive: true });
    writeFileSync(cdCachePath(), JSON.stringify({ version: 2, builtAt: Date.now(), repos: sampleRepos }));

    expect(readRepoCache()).toBeNull();
  });

  test("write is atomic: no readable partial file survives (temp write + rename)", () => {
    writeRepoCache(sampleRepos);

    // No temp file (fixed-name or the new per-call random-suffixed name)
    // survives a successful write.
    const dir = dirname(cdCachePath());
    const leftoverTmp = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftoverTmp).toEqual([]);
    // The real path must always parse as a complete, valid payload.
    const raw = readFileSync(cdCachePath(), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.repos).toEqual(sampleRepos);
  });

  test("temp file name is per-call, not a fixed shared path (concurrent writers can't clobber each other)", () => {
    const renamedFrom: string[] = [];
    const spy = spyOn(fs, "renameSync").mockImplementation((from: unknown) => {
      renamedFrom.push(String(from));
    });

    writeRepoCache(sampleRepos);
    writeRepoCache(sampleRepos);

    spy.mockRestore();
    expect(renamedFrom).toHaveLength(2);
    // Distinct per call, so two writers racing never share a temp path.
    expect(renamedFrom[0]).not.toBe(renamedFrom[1]);
    for (const tmpPath of renamedFrom) {
      expect(tmpPath.startsWith(cdCachePath())).toBe(true);
      expect(tmpPath).toContain(String(process.pid));
      expect(tmpPath.endsWith(".tmp")).toBe(true);
    }
  });

  test("a stale fixed-name temp file from the old naming scheme is left untouched", () => {
    // Pre-hardening, every writer raced on this exact path. A leftover file
    // there (from another process, or a crash) must not be read, written,
    // or removed by a write using the new per-call naming.
    const foreignTmp = `${cdCachePath()}.tmp`;
    mkdirSync(dirname(cdCachePath()), { recursive: true });
    writeFileSync(foreignTmp, "not touched by this writer");

    writeRepoCache(sampleRepos);

    expect(readFileSync(foreignTmp, "utf8")).toBe("not touched by this writer");
    expect(readRepoCache()?.repos).toEqual(sampleRepos);
  });

  test("writeRepoCache never throws even when the target directory cannot be created", () => {
    // Point HOME at a path that can't be a directory (a file in its place),
    // so mkdirSync inside writeRepoCache is forced to fail.
    const blocked = join(home, "blocked-home");
    writeFileSync(blocked, "not a directory");
    process.env.HOME = blocked;

    expect(() => writeRepoCache(sampleRepos)).not.toThrow();
  });
});
