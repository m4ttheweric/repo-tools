/**
 * rt-paths — the single source of truth for ~/.rt layout.
 *
 * Includes a SOURCE-GUARD test that fails the build if the old per-repo-at-root
 * pattern (`join(RT_DIR, repoName, ...)` / `join(homedir(), ".rt", repoName)`)
 * reappears anywhere in lib/ outside this module. That tripwire is the point:
 * it keeps a future relayout a one-line change here instead of a scavenger hunt.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { rtDir, reposDir, repoDataDir } from "../rt-paths.ts";

describe("rt-paths", () => {
  const origHome = process.env.HOME;
  afterEach(() => { process.env.HOME = origHome; });

  test("per-repo data dir nests under ~/.rt/repos/<repo> at call-time HOME", () => {
    process.env.HOME = "/tmp/fake-home-abc";
    expect(rtDir()).toBe("/tmp/fake-home-abc/.rt");
    expect(reposDir()).toBe("/tmp/fake-home-abc/.rt/repos");
    expect(repoDataDir("my-repo")).toBe("/tmp/fake-home-abc/.rt/repos/my-repo");
  });

  test("HOME is resolved at call time (a later change takes effect)", () => {
    process.env.HOME = "/tmp/home-1";
    expect(repoDataDir("r")).toBe("/tmp/home-1/.rt/repos/r");
    process.env.HOME = "/tmp/home-2";
    expect(repoDataDir("r")).toBe("/tmp/home-2/.rt/repos/r");
  });

  test("a repo dir is NEVER directly under ~/.rt (regression guard for the move)", () => {
    process.env.HOME = "/tmp/h";
    expect(repoDataDir("x")).toBe(join(reposDir(), "x"));
    expect(repoDataDir("x")).not.toBe(join(rtDir(), "x"));
  });

  // ── Source-guard: no per-repo-at-root paths outside this module ──────────────
  test("no code in lib/ reconstructs ~/.rt/<repoName> by hand", () => {
    const libDir = join(import.meta.dir, "..");
    // The old per-repo-at-root shapes. Per-repo paths MUST go through
    // repoDataDir(); app-level joins use string literals and are not matched.
    const antipatterns = [
      /join\(\s*RT_DIR\s*,\s*[a-zA-Z_$]/,                       // join(RT_DIR, repoName...
      /join\(\s*homedir\(\)\s*,\s*"\.rt"\s*,\s*[a-zA-Z_$]/,     // join(homedir(), ".rt", repoName)
      /["']\.rt["']\s*,\s*repoName/,                            // ".rt", repoName
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "node_modules" || entry === "__tests__") continue;
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        if (full.endsWith("/rt-paths.ts")) continue; // the one allowed home
        const src = readFileSync(full, "utf8");
        src.split("\n").forEach((line, i) => {
          if (antipatterns.some((re) => re.test(line))) {
            offenders.push(`${full}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    };
    walk(libDir);
    expect(offenders, `Per-repo paths must use repoDataDir() from rt-paths.ts:\n${offenders.join("\n")}`).toEqual([]);
  });
});
