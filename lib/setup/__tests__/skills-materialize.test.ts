import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { updateRepoIndex } from "../../repo-index.ts";
import { fakeProbes } from "./fakes.ts";
import { findMergeManifests, materializeSkills } from "../skills-materialize.ts";
import { UserActionableError } from "../errors.ts";

const VERSIONS_DIR = "/fake-home/.claude/plugins/cache/mattstack/mattstack";
const SCRIPT_TAIL = ["plugin", "skills", "parameterized-skills", "scripts", "merge-manifests.sh"];

function scriptPath(version: string): string {
  return join(VERSIONS_DIR, version, ...SCRIPT_TAIL);
}

describe("findMergeManifests", () => {
  test("picks the highest semver version dir carrying the script", () => {
    const p = fakeProbes({
      home: "/fake-home",
      dirs: { [VERSIONS_DIR]: ["0.3.1", "0.4.1"] },
      files: { [scriptPath("0.3.1")]: "#!/bin/sh\n", [scriptPath("0.4.1")]: "#!/bin/sh\n" },
    });

    expect(findMergeManifests(p)).toBe(scriptPath("0.4.1"));
  });

  test("RT_MERGE_MANIFESTS env override wins outright", () => {
    const p = fakeProbes({ env: { RT_MERGE_MANIFESTS: "/custom/merge-manifests.sh" } });
    expect(findMergeManifests(p)).toBe("/custom/merge-manifests.sh");
  });

  test("null when no version dir carries the script", () => {
    const p = fakeProbes({ home: "/fake-home", dirs: { [VERSIONS_DIR]: ["0.1.0"] } });
    expect(findMergeManifests(p)).toBeNull();
  });

  test("null when the cache dir doesn't exist at all", () => {
    const p = fakeProbes({ home: "/fake-home" });
    expect(findMergeManifests(p)).toBeNull();
  });
});

describe("materializeSkills", () => {
  // getKnownRepos() (unlike the Probes fake above) reads real repos.json off
  // process.env.HOME — a per-test HOME keeps this from writing into the
  // ambient test-setup.ts one that other test files share assumptions about.
  const origHome = process.env.HOME;
  let home: string;
  let repoDir: string;
  let repoName: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-materialize-home-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  function seedRepo(): void {
    repoDir = mkdtempSync(join(home, "repo-"));
    repoName = basename(repoDir);
    updateRepoIndex(repoName, repoDir);
  }

  test("runs `bash <script> --repo <path>` with MATTSTACK_HOME set", async () => {
    seedRepo();
    const calls: { argv: string[]; env?: Record<string, string> }[] = [];
    const p = fakeProbes({
      home: "/fake-home",
      env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
      exec: async (argv, opts) => {
        calls.push({ argv, env: opts?.env });
        return { code: 0, stdout: "wrote skills.jsonc", stderr: "" };
      },
    });

    const result = await materializeSkills(p, { repo: repoName });

    expect(calls).toEqual([{ argv: ["bash", "/fake-home/merge-manifests.sh", "--repo", repoDir], env: { MATTSTACK_HOME: "/fake-home/.mattstack" } }]);
    expect(result.repos).toEqual([{ name: repoName, path: repoDir, ok: true, detail: "wrote skills.jsonc" }]);
  });

  test("exit 2 (no git remote) is reported per-repo, not thrown", async () => {
    seedRepo();
    const p = fakeProbes({
      home: "/fake-home",
      env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
      exec: async () => ({ code: 2, stdout: "", stderr: "no git remote" }),
    });

    const result = await materializeSkills(p, { repo: repoName });

    expect(result.repos).toEqual([{ name: repoName, path: repoDir, ok: false, detail: "no git remote" }]);
  });

  test("throws UserActionableError('merge-manifests-missing') when the script can't be found", async () => {
    const p = fakeProbes({ home: "/fake-home" });

    await expect(materializeSkills(p, {})).rejects.toThrow(UserActionableError);
    try {
      await materializeSkills(p, {});
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as UserActionableError).code).toBe("merge-manifests-missing");
    }
  });

  test("throws UserActionableError('repo-not-registered') for an unknown --repo", async () => {
    const p = fakeProbes({ home: "/fake-home", env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" } });

    try {
      await materializeSkills(p, { repo: "no-such-repo-xyz" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as UserActionableError).code).toBe("repo-not-registered");
    }
  });
});
