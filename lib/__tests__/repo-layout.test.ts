/**
 * Behavioral guard: the public per-repo save APIs write under ~/.mattstack/rt/repos/<repo>/
 * and NOT directly under ~/.mattstack/rt/<repo>/. Exercises the real modules (not just the
 * path helper) so a regression in any one of them is caught.
 *
 * Uses an isolated HOME under a temp dir. rt-paths resolves HOME at call time,
 * so setting process.env.HOME before calling redirects the whole tree.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repoDataDir } from "../rt-paths.ts";
import { saveTemplate } from "../doppler-template.ts";

describe("per-repo files land under ~/.mattstack/rt/repos/<repo>/", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-layout-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  const newPath = (repo: string, file: string) => join(home, ".mattstack", "rt", "repos", repo, file);
  const oldPath = (repo: string, file: string) => join(home, ".mattstack", "rt", repo, file);

  test("repoDataDir resolves under the isolated HOME", () => {
    expect(repoDataDir("acme")).toBe(join(home, ".mattstack", "rt", "repos", "acme"));
  });

  test("doppler saveTemplate writes under repos/", () => {
    saveTemplate("acme", [{ path: "apps/api", project: "api", config: "dev" }]);
    expect(existsSync(newPath("acme", "doppler-template.yaml"))).toBe(true);
    expect(existsSync(oldPath("acme", "doppler-template.yaml"))).toBe(false);
  });
});
