import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { updateRepoIndex } from "../../repo-index.ts";
import { setSetting } from "../../settings/write.ts";
import { fakeProbes } from "./fakes.ts";
import { findMergeManifests, materializeSkills, MERGE_MANIFESTS_MISSING_CODE } from "../skills-materialize.ts";
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
    expect(result).toEqual({ skipped: false, repos: [{ name: repoName, path: repoDir, ok: true, detail: "wrote skills.jsonc" }] });
  });

  test("exit 2 (no git remote) is reported per-repo, not thrown", async () => {
    seedRepo();
    const p = fakeProbes({
      home: "/fake-home",
      env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
      exec: async () => ({ code: 2, stdout: "", stderr: "no git remote" }),
    });

    const result = await materializeSkills(p, { repo: repoName });

    expect(result).toEqual({ skipped: false, repos: [{ name: repoName, path: repoDir, ok: false, detail: "no git remote" }] });
  });

  test("skips honestly (never throws) when the script can't be found — the ordinary fresh-machine case", async () => {
    const p = fakeProbes({ home: "/fake-home" });

    const result = await materializeSkills(p, {});

    expect(result.skipped).toBe(true);
    if (!result.skipped) throw new Error("expected skipped:true");
    expect(result.reason).toContain(MERGE_MANIFESTS_MISSING_CODE);
    expect(result.repos).toEqual([]);
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

  test("targets only registered repos, not scanned (unregistered) candidates", async () => {
    seedRepo(); // registered

    const scannedDir = mkdtempSync(join(home, "scanned-"));
    mkdirSync(join(scannedDir, ".git")); // a real .git marker, never indexed via updateRepoIndex
    setSetting("rt.repoRoots", [home], "machine"); // makes `home` a configured root scanRoot() walks

    const p = fakeProbes({
      home: "/fake-home",
      env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
      exec: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    });

    const result = await materializeSkills(p, {});

    expect(result.skipped).toBe(false);
    if (result.skipped) throw new Error("expected skipped:false");
    expect(result.repos.map((r) => r.name)).toEqual([repoName]);
  });

  test("idempotent: two calls against the same present script produce the same outcome", async () => {
    seedRepo();
    const p = fakeProbes({
      home: "/fake-home",
      env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
      exec: async () => ({ code: 0, stdout: "wrote skills.jsonc", stderr: "" }),
    });

    const first = await materializeSkills(p, { repo: repoName });
    const second = await materializeSkills(p, { repo: repoName });

    expect(second).toEqual(first);
  });

  test("re-callable: a skipped call followed by a call after the plugin appears succeeds (plugins.install's re-call contract)", async () => {
    seedRepo();
    const beforePlugin = fakeProbes({ home: "/fake-home" });
    const first = await materializeSkills(beforePlugin, { repo: repoName });
    expect(first.skipped).toBe(true);

    const afterPlugin = fakeProbes({
      home: "/fake-home",
      env: { RT_MERGE_MANIFESTS: "/fake-home/merge-manifests.sh" },
      exec: async () => ({ code: 0, stdout: "wrote skills.jsonc", stderr: "" }),
    });
    const second = await materializeSkills(afterPlugin, { repo: repoName });

    expect(second).toEqual({ skipped: false, repos: [{ name: repoName, path: repoDir, ok: true, detail: "wrote skills.jsonc" }] });
  });
});
