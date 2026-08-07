import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createControllerClient,
  ensureEndpoints,
  failureExitCode,
  manifestHash,
  normalizeOrigin,
  pushSnapshot,
  readRepoOverlay,
  receiverSshEnv,
  resolveBaseRef,
  resolveRepoId,
  statusExitCode,
  summarizeRun,
  verdictExitCode,
  type GitPushSpawn,
  type Run,
} from "../validate-farm.ts";
import { SnapshotBaseRefError } from "../snapshot.ts";

// ─── repoId resolution (fixture overlay dir, never the real ~/.rt) ───────────

describe("resolveRepoId", () => {
  let overlayRoot: string;

  beforeEach(() => {
    overlayRoot = mkdtempSync(join(tmpdir(), "rt-overlay-"));
    const dir = join(overlayRoot, "acme-dev");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "repo.jsonc"),
      `{\n  // the mirror origin\n  "origin": "https://gitlab.com/acme/acme-dev.git",\n  "defaultBranch": "master",\n}\n`,
    );
    // Overlay dir with no repo.jsonc must be skipped, not crash the scan.
    mkdirSync(join(overlayRoot, "no-mapping"));
  });

  afterEach(() => {
    try { rmSync(overlayRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  test("matches the overlay dir by origin URL", () => {
    expect(resolveRepoId("https://gitlab.com/acme/acme-dev.git", overlayRoot)).toBe("acme-dev");
  });

  test("matches across ssh/https spellings of the same origin", () => {
    expect(resolveRepoId("git@gitlab.com:acme/acme-dev.git", overlayRoot)).toBe("acme-dev");
    expect(resolveRepoId("ssh://git@gitlab.com/acme/acme-dev", overlayRoot)).toBe("acme-dev");
  });

  test("matches the reverse direction: ssh-form overlay, https-form worktree", () => {
    const dir = join(overlayRoot, "ssh-overlay");
    mkdirSync(dir);
    writeFileSync(join(dir, "repo.jsonc"), `{ "origin": "git@gitlab.com:acme/other.git" }\n`);
    expect(resolveRepoId("https://gitlab.com/acme/other", overlayRoot)).toBe("ssh-overlay");
    expect(resolveRepoId("https://gitlab.com/acme/other.git", overlayRoot)).toBe("ssh-overlay");
  });

  test("returns null for an origin no overlay claims", () => {
    expect(resolveRepoId("git@github.com:someone/else.git", overlayRoot)).toBeNull();
  });

  test("returns null when the overlay root does not exist", () => {
    expect(resolveRepoId("git@gitlab.com:a/b.git", join(overlayRoot, "missing"))).toBeNull();
  });

  test("skips a malformed repo.jsonc instead of throwing", () => {
    const bad = join(overlayRoot, "broken");
    mkdirSync(bad);
    writeFileSync(join(bad, "repo.jsonc"), "{ not json");
    expect(resolveRepoId("https://gitlab.com/acme/acme-dev.git", overlayRoot)).toBe("acme-dev");
  });
});

describe("normalizeOrigin", () => {
  test("all spellings of one repo normalize identically", () => {
    const want = "gitlab.com/acme/acme-dev";
    expect(normalizeOrigin("git@gitlab.com:acme/acme-dev.git")).toBe(want);
    expect(normalizeOrigin("https://gitlab.com/acme/acme-dev")).toBe(want);
    expect(normalizeOrigin("ssh://git@gitlab.com/acme/acme-dev.git")).toBe(want);
  });
});

// ─── base-ref resolution (fixture overlay + fixture git repo) ────────────────

describe("resolveBaseRef", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rt-baseref-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    execSync(`git init -q "${repo}"`);
    execSync(`git -C "${repo}" config user.email t@t && git -C "${repo}" config user.name t`);
    writeFileSync(join(repo, "a.txt"), "a\n");
    execSync(`git -C "${repo}" add . && git -C "${repo}" commit -q -m init`);
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  function writeOverlay(repoId: string, body: string): string {
    const dir = join(root, "overlays", repoId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "repo.jsonc"), body);
    return join(root, "overlays");
  }

  test("overlay defaultBranch wins when declared", () => {
    const overlays = writeOverlay("r", `{ "origin": "x", "defaultBranch": "main" }\n`);
    expect(resolveBaseRef("r", repo, overlays)).toBe("refs/remotes/origin/main");
  });

  test("falls back to the detected remote default branch (origin/main)", () => {
    execSync(`git -C "${repo}" update-ref refs/remotes/origin/main HEAD`);
    const overlays = writeOverlay("r", `{ "origin": "x" }\n`);
    expect(resolveBaseRef("r", repo, overlays)).toBe("refs/remotes/origin/main");
  });

  test("falls back to origin/master when nothing is declared or detected", () => {
    const overlays = writeOverlay("r", `{ "origin": "x" }\n`);
    expect(resolveBaseRef("r", repo, overlays)).toBe("refs/remotes/origin/master");
  });
});

describe("readRepoOverlay", () => {
  test("reads defaultBranch through jsonc comments; null on missing/malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "rt-overlay-read-"));
    try {
      const dir = join(root, "r");
      mkdirSync(dir);
      writeFileSync(join(dir, "repo.jsonc"), `{\n  // comment\n  "origin": "x",\n  "defaultBranch": "master",\n}\n`);
      expect(readRepoOverlay("r", root)).toEqual({ origin: "x", defaultBranch: "master" });
      expect(readRepoOverlay("missing", root)).toBeNull();
      const bad = join(root, "bad");
      mkdirSync(bad);
      writeFileSync(join(bad, "repo.jsonc"), "{ not json");
      expect(readRepoOverlay("bad", root)).toBeNull();
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});

// ─── manifest hashing ────────────────────────────────────────────────────────

describe("manifestHash", () => {
  test("stable under key reordering", () => {
    const a = { image: "img", taskGroups: [{ name: "lint", run: "x" }], env: { A: "1", B: "2" } };
    const b = { env: { B: "2", A: "1" }, taskGroups: [{ run: "x", name: "lint" }], image: "img" };
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  test("changes when content changes", () => {
    const a = { image: "img", taskGroups: [{ name: "lint", run: "x" }] };
    const b = { image: "img", taskGroups: [{ name: "lint", run: "y" }] };
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });

  test("array order is content, not noise", () => {
    const a = { taskGroups: [{ name: "a" }, { name: "b" }] };
    const b = { taskGroups: [{ name: "b" }, { name: "a" }] };
    expect(manifestHash(a)).not.toBe(manifestHash(b));
  });
});

// ─── controller client (injected fetch) ──────────────────────────────────────

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1", repoId: "acme-dev", tree: "t1", manifestHash: "m1",
    status: "done", groups: [], createdAt: "2026-08-07T00:00:00Z",
    ...over,
  };
}

describe("createControllerClient", () => {
  test("submit POSTs the request and returns runId + cached", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ runId: "r1", cached: false }), { status: 200 });
    }) as typeof fetch;

    const client = createControllerClient("http://ctrl:8080", fetchFn);
    const req = {
      repoId: "acme-dev", tree: "t1", manifestHash: "m1",
      manifest: { image: "img", taskGroups: [] }, changedFiles: ["a.ts"], mergeBase: "mb",
    };
    const res = await client.submit(req);

    expect(res).toEqual({ runId: "r1", cached: false });
    expect(calls[0]!.url).toBe("http://ctrl:8080/validate");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(req);
  });

  test("submit sends force: true in the body only when forcing", async () => {
    // Cluster-verify pending: the controller side of force (fresh run,
    // verdict-cache and in-flight attach skipped, cached: false) is the
    // sibling contract — only the request shape is provable here.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: any, init?: any) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ runId: "r1", cached: false }), { status: 200 });
    }) as typeof fetch;

    const client = createControllerClient("http://ctrl:8080", fetchFn);
    const base = {
      repoId: "acme-dev", tree: "t1", manifestHash: "m1",
      manifest: { image: "img", taskGroups: [] }, changedFiles: [], mergeBase: "mb",
    };
    await client.submit({ ...base, force: true });
    await client.submit(base);

    expect(bodies[0]!.force).toBe(true);
    expect("force" in bodies[1]!).toBe(false);
  });

  test("getRun returns null on 404 and the Run on 200", async () => {
    const fetchFn = (async (url: any) => {
      if (String(url).endsWith("/runs/missing")) return new Response("", { status: 404 });
      return new Response(JSON.stringify(run()), { status: 200 });
    }) as typeof fetch;

    const client = createControllerClient("http://ctrl:8080", fetchFn);
    expect(await client.getRun("missing")).toBeNull();
    expect((await client.getRun("r1"))?.id).toBe("r1");
  });

  test("getGroupLog returns the log text", async () => {
    const fetchFn = (async (url: any) => {
      expect(String(url)).toBe("http://ctrl:8080/runs/r1/logs/lint");
      return new Response("boom", { status: 200 });
    }) as typeof fetch;
    const client = createControllerClient("http://ctrl:8080", fetchFn);
    expect(await client.getGroupLog("r1", "lint")).toBe("boom");
  });
});

// ─── verdict mapping ─────────────────────────────────────────────────────────

describe("verdictExitCode", () => {
  test("all pass → 0 (farm-green)", () => {
    expect(verdictExitCode(run({ groups: [{ name: "lint", status: "pass" }] }))).toBe(0);
  });

  test("inherited-only failures stay farm-green → 0", () => {
    expect(verdictExitCode(run({ groups: [
      { name: "lint", status: "pass" },
      { name: "tests", status: "inherited" },
    ] }))).toBe(0);
  });

  test("skipped groups do not affect the verdict", () => {
    expect(verdictExitCode(run({ groups: [{ name: "cvi", status: "skipped" }] }))).toBe(0);
  });

  test("any fail → 1", () => {
    expect(verdictExitCode(run({ groups: [
      { name: "lint", status: "pass" },
      { name: "tests", status: "fail" },
    ] }))).toBe(1);
  });

  test("run infra or any infra group → 2", () => {
    expect(verdictExitCode(run({ status: "infra" }))).toBe(2);
    expect(verdictExitCode(run({ groups: [{ name: "tests", status: "infra" }] }))).toBe(2);
  });
});

describe("statusExitCode", () => {
  test("run not found → 64 (usage, not farm-red)", () => {
    expect(statusExitCode(null)).toBe(64);
  });

  test("still in flight → 3, distinct from every verdict code", () => {
    expect(statusExitCode(run({ status: "pending" }))).toBe(3);
    expect(statusExitCode(run({ status: "running", groups: [{ name: "lint", status: "pass" }] }))).toBe(3);
  });

  test("finished runs use the verdict contract", () => {
    expect(statusExitCode(run({ groups: [{ name: "lint", status: "pass" }] }))).toBe(0);
    expect(statusExitCode(run({ groups: [{ name: "lint", status: "fail" }] }))).toBe(1);
    expect(statusExitCode(run({ status: "infra" }))).toBe(2);
  });
});

describe("failureExitCode", () => {
  test("a missing base ref is usage (64)", () => {
    expect(failureExitCode(new SnapshotBaseRefError("refs/remotes/origin/master"))).toBe(64);
  });

  test("everything else is infra (2), never red", () => {
    expect(failureExitCode(new Error("controller POST /validate failed: 500"))).toBe(2);
    expect(failureExitCode(new Error("git write-tree failed (exit 128)"))).toBe(2);
    expect(failureExitCode("string throw")).toBe(2);
  });
});

describe("summarizeRun", () => {
  test("speaks farm language, never CI-green", () => {
    const green = summarizeRun(run({ groups: [{ name: "lint", status: "pass" }] }));
    expect(green).toContain("farm-green");
    expect(green).not.toContain("CI");
  });

  test("labels inherited-only failures", () => {
    const s = summarizeRun(run({ groups: [
      { name: "lint", status: "pass" },
      { name: "tests", status: "inherited" },
    ] }));
    expect(s).toContain("inherited");
    expect(s).toContain("farm-green");
  });

  test("infra is not a code verdict", () => {
    expect(summarizeRun(run({ status: "infra" }))).toContain("not a code verdict");
  });
});

// ─── receiver push (injected spawn) ──────────────────────────────────────────

describe("receiverSshEnv", () => {
  test("empty when MC_RECEIVER_SSH_KEY is unset — ssh's own resolution applies", () => {
    expect(receiverSshEnv({})).toEqual({});
  });

  test("pins GIT_SSH_COMMAND to exactly the named key when set", () => {
    expect(receiverSshEnv({ MC_RECEIVER_SSH_KEY: "/keys/receiver_ed25519" })).toEqual({
      GIT_SSH_COMMAND: "ssh -i /keys/receiver_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
    });
  });
});

describe("pushSnapshot", () => {
  function fakeSpawn(exitCode: number, stderr = "") {
    const calls: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = [];
    const spawn: GitPushSpawn = async (argv, opts) => {
      calls.push({ argv: [...argv], cwd: opts.cwd, env: { ...opts.env } });
      return { exitCode, stderr };
    };
    return { spawn, calls };
  }

  test("pushes commit:refs/snapshots/<tree> to the receiver repo URL from the worktree", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const out = await pushSnapshot({
      repoId: "acme-dev", commit: "c1", tree: "t1", cwd: "/wt", spawn, env: {},
    });
    expect(out.ok).toBe(true);
    expect(calls[0]!.argv).toEqual([
      "git", "push", "ssh://git@localhost:2222/repos/acme-dev.git", "+c1:refs/snapshots/t1",
    ]);
    expect(calls[0]!.cwd).toBe("/wt");
    expect(calls[0]!.env).toEqual({}); // no key knob → default ssh resolution
  });

  test("threads MC_RECEIVER_SSH_KEY into the push env as GIT_SSH_COMMAND", async () => {
    const { spawn, calls } = fakeSpawn(0);
    await pushSnapshot({
      repoId: "acme-dev", commit: "c1", tree: "t1", cwd: "/wt", spawn,
      env: { MC_RECEIVER_SSH_KEY: "/keys/receiver_ed25519" },
    });
    expect(calls[0]!.env.GIT_SSH_COMMAND).toBe(
      "ssh -i /keys/receiver_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
    );
  });

  test("surfaces a failed push with its stderr", async () => {
    const { spawn } = fakeSpawn(128, "fatal: Could not read from remote repository.\n");
    const out = await pushSnapshot({
      repoId: "acme-dev", commit: "c1", tree: "t1", cwd: "/wt", spawn, env: {},
    });
    expect(out.ok).toBe(false);
    expect(out.stderr).toContain("Could not read");
  });
});

// ─── endpoint readiness ──────────────────────────────────────────────────────

describe("ensureEndpoints", () => {
  const noDelay = () => Promise.resolve();

  test("does not spawn when the controller already answers", async () => {
    let spawned = false;
    const handle = await ensureEndpoints({
      probe: async () => true,
      spawnForwards: () => { spawned = true; return { stop: () => {} }; },
      delayMs: noDelay,
    });
    expect(handle.status).toBe("already-up");
    expect(spawned).toBe(false);
  });

  test("spawns forwards and reports ready once the probe flips", async () => {
    let probes = 0;
    let spawned = false;
    const handle = await ensureEndpoints({
      probe: async () => ++probes > 2,
      spawnForwards: () => { spawned = true; return { stop: () => {} }; },
      delayMs: noDelay,
    });
    expect(handle.status).toBe("forwarded");
    expect(spawned).toBe(true);
  });

  test("stops the forwards and reports unreachable when the probe never flips", async () => {
    let stopped = false;
    const handle = await ensureEndpoints({
      probe: async () => false,
      spawnForwards: () => ({ stop: () => { stopped = true; } }),
      delayMs: noDelay,
    });
    expect(handle.status).toBe("unreachable");
    expect(stopped).toBe(true);
  });
});
