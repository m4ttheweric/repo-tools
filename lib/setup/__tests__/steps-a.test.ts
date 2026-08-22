import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";
import { HELPERS_DIR, RT_BUNDLE_PATH, __test__ as bundleLayoutTest } from "../../bundle-layout.ts";
import { getSetting } from "../../settings/resolve.ts";
import { setSetting } from "../../settings/write.ts";
import { linkPath } from "../../deps/links.ts";
import type { ExecResult, Probes } from "../probes.ts";
import type { SecretsExecResult, SecretsExecSeam, SecretsSeams } from "../../secrets/store.ts";
import type { RelayClient } from "../../team/relay-client.ts";
import type { ApplyContext, StepOutcome } from "../apply.ts";
import { AUTH_FAILURE_PATTERN } from "../../team/publish.ts";
import { intentPath, type SetupIntent } from "../intent.ts";
import { stagingDir } from "../staging.ts";
import { fakeProbes } from "./fakes.ts";

import { homeInitStep, homeRestoreStep } from "../steps/home.ts";
import { teamCreateStep, teamJoinStep } from "../steps/team.ts";
import { secretsWriteStep } from "../steps/secrets.ts";
import { pathLinkStep } from "../steps/path.ts";
import { settingsSeedStep } from "../steps/settings.ts";
import { reposCloneStep } from "../steps/repos.ts";
import { interceptsInstallStep } from "../steps/index.ts";

// ─── shared fakes ────────────────────────────────────────────────────────────

/** Existing key "AGE-SECRET-KEY-1FAKE" derives to "age1fake" — enough for ensureAgeKey/readAgeKey's happy path without exercising the mint-a-new-key branch. */
function fakeAgeKeySeamWithKey(): AgeKeySeam {
  return {
    async run(cmd): Promise<AgeExecResult> {
      if (cmd[0] === "security" && cmd[1] === "find-generic-password") {
        return { code: 0, stdout: "AGE-SECRET-KEY-1FAKE\n", stderr: "" };
      }
      if (cmd[0] === "age-keygen" && cmd[1] === "-y") {
        return { code: 0, stdout: "age1fake\n", stderr: "" };
      }
      throw new Error(`fakeAgeKeySeamWithKey: unexpected call ${cmd.join(" ")}`);
    },
  };
}

function fakeAgeKeySeamAbsent(): AgeKeySeam {
  return {
    async run(): Promise<AgeExecResult> {
      return { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
    },
  };
}

/** Round-trips whatever it just "encrypted" back out of "-d", the same trick lib/secrets/__tests__/store.test.ts uses — writeSecret's own post-encrypt readback check would otherwise fail every write. */
class FakeSecretsExecSeam implements SecretsExecSeam {
  files = new Map<string, string>();
  private roundTrippable = new Map<string, string>();

  fileExists(path: string): boolean {
    return this.files.has(path);
  }
  listDir(): string[] {
    return [];
  }
  statFile(): { mtimeMs: number; size: number } | null {
    return null;
  }
  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`FakeSecretsExecSeam: missing ${path}`);
    return content;
  }
  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }
  ensureDir(): void {}
  chmod(): void {}
  fsyncAndRename(from: string, to: string): void {
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.set(to, content);
      this.files.delete(from);
    }
  }
  removeFile(path: string): void {
    this.files.delete(path);
  }
  async run(cmd: string[]): Promise<SecretsExecResult> {
    if (cmd[0] === "sops" && cmd[1] === "-d") {
      const target = cmd[cmd.length - 1]!;
      const staged = this.roundTrippable.get(target);
      return staged !== undefined ? { code: 0, stdout: staged, stderr: "" } : { code: 0, stdout: "{}", stderr: "" };
    }
    if (cmd[0] === "sops" && cmd[1] === "-e") {
      const outputPath = cmd[cmd.indexOf("--output") + 1]!;
      const stagingPath = cmd[cmd.length - 1]!;
      this.files.set(outputPath, "ciphertext");
      const staged = this.files.get(stagingPath);
      if (staged !== undefined) this.roundTrippable.set(outputPath, staged);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`FakeSecretsExecSeam: unexpected call ${cmd.join(" ")}`);
  }
}

function fakeSecrets(ageKeySeam: AgeKeySeam = fakeAgeKeySeamWithKey()): SecretsSeams {
  return { ageKeySeam, execSeam: new FakeSecretsExecSeam() };
}

const fakeRelay: RelayClient = {
  create: async () => ({ id: "", creatorSecret: "" }),
  fetch: async () => "gone",
  redeem: async () => "already",
  reply: async () => {},
  readReply: async () => "none",
  delete: async () => {},
};

function makeCtx(p: Probes, overrides: Partial<ApplyContext> = {}): { ctx: ApplyContext; logs: { id: string; line: string }[] } {
  const logs: { id: string; line: string }[] = [];
  const ctx: ApplyContext = {
    p,
    emit: () => {},
    log(id, line) {
      logs.push({ id, line });
    },
    intent: null,
    team: { slug: "", name: "", mode: "none" },
    snapshot: null,
    reqs: [],
    nonInteractive: false,
    teamOfOne: false,
    appPath: null,
    ci: false,
    secrets: fakeSecrets(),
    relay: fakeRelay,
    redact: () => {},
    async need() {
      return "no-app";
    },
    ...overrides,
  };
  return { ctx, logs };
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

// ─── home.init ───────────────────────────────────────────────────────────────

describe("home.init", () => {
  test("applies unless intent.mode is restore", () => {
    const { ctx: noIntent } = makeCtx(fakeProbes());
    expect(homeInitStep.applies(noIntent)).toBe(true);

    const { ctx: restoring } = makeCtx(fakeProbes(), { intent: { v: 1, at: "", mode: "restore" } as SetupIntent });
    expect(homeInitStep.applies(restoring)).toBe(false);
  });

  test("already cloned + key present -> done, never re-runs `rt home init`", async () => {
    const p = fakeProbes({ home: "/fake-home", dirs: { "/fake-home/.mattstack/user": [".git"] }, files: { "/fake-home/.mattstack/user/.git": "gitdir" } });
    const { ctx } = makeCtx(p, { secrets: fakeSecrets(fakeAgeKeySeamWithKey()) });

    const outcome = await homeInitStep.run(ctx);
    expect(outcome).toEqual({ state: "done", detail: "already initialized" });
    expect(p.calls.exec).toEqual([]);
  });

  test("missing clone -> runs `rt home init`; success reports the last stdout line", async () => {
    const p = fakeProbes({
      home: "/fake-home",
      runRt: async (args) => {
        expect(args).toEqual(["home", "init"]);
        return ok("rt home init: step one\nrt home init: /fake-home/.mattstack is provisioned.");
      },
    });
    const { ctx } = makeCtx(p, { secrets: fakeSecrets(fakeAgeKeySeamAbsent()) });

    const outcome = await homeInitStep.run(ctx);
    expect(outcome).toEqual({ state: "done", detail: "rt home init: /fake-home/.mattstack is provisioned." });
  });

  test("`rt home init` failure -> failed, remedy points at gh auth login", async () => {
    const p = fakeProbes({
      home: "/fake-home",
      runRt: async () => ({ code: 1, stdout: "", stderr: "gh: not authenticated\nsee gh auth login" }),
    });
    const { ctx } = makeCtx(p, { secrets: fakeSecrets(fakeAgeKeySeamAbsent()) });

    const outcome = await homeInitStep.run(ctx);
    expect(outcome).toEqual({ state: "failed", detail: "gh: not authenticated", remedy: "Run `gh auth login`, then Retry" });
  });

  test("idempotent re-run: a repo already cloned by a prior partial run reports done again without re-running init", async () => {
    const p = fakeProbes({ home: "/fake-home", dirs: { "/fake-home/.mattstack/user": [".git"] }, files: { "/fake-home/.mattstack/user/.git": "gitdir" } });
    const { ctx } = makeCtx(p, { secrets: fakeSecrets(fakeAgeKeySeamWithKey()) });

    expect(await homeInitStep.run(ctx)).toEqual({ state: "done", detail: "already initialized" });
    expect(await homeInitStep.run(ctx)).toEqual({ state: "done", detail: "already initialized" });
  });
});

// ─── home.restore ────────────────────────────────────────────────────────────

describe("home.restore", () => {
  const restoreIntent: SetupIntent = { v: 1, at: "", mode: "restore", restore: { homeRepo: "acme/mattstack-home" } };

  test("applies only when intent.mode is restore", () => {
    const { ctx: restoring } = makeCtx(fakeProbes(), { intent: restoreIntent });
    expect(homeRestoreStep.applies(restoring)).toBe(true);
    const { ctx: notRestoring } = makeCtx(fakeProbes());
    expect(homeRestoreStep.applies(notRestoring)).toBe(false);
  });

  test("clone present, origin names the repo, key present -> done restored (verifier only — never runs restore itself)", async () => {
    const p = fakeProbes({
      home: "/fake-home",
      dirs: { "/fake-home/.mattstack/user/.git": [] },
      files: {
        "/fake-home/.mattstack/user/.git": "gitdir",
        "/fake-home/.mattstack/user/.git/config": '[remote "origin"]\n\turl = https://github.com/acme/mattstack-home.git\n',
      },
    });
    const { ctx } = makeCtx(p, { intent: restoreIntent, secrets: fakeSecrets(fakeAgeKeySeamWithKey()) });

    expect(await homeRestoreStep.run(ctx)).toEqual({ state: "done", detail: "restored" });
    expect(p.calls.exec).toEqual([]); // never shells out to `rt restore` itself
  });

  test("no clone yet -> failed, remedy names `rt restore <org>/<repo>`", async () => {
    const p = fakeProbes({ home: "/fake-home" });
    const { ctx } = makeCtx(p, { intent: restoreIntent, secrets: fakeSecrets(fakeAgeKeySeamAbsent()) });

    const outcome = await homeRestoreStep.run(ctx);
    expect(outcome.state).toBe("failed");
    expect((outcome as { remedy?: string }).remedy).toBe("Run `rt restore <org>/<repo>` (pastes your age key), then Retry");
  });

  test("cloned but wrong origin -> failed (never trusts a same-shaped clone of a different repo)", async () => {
    const p = fakeProbes({
      home: "/fake-home",
      dirs: { "/fake-home/.mattstack/user/.git": [] },
      files: { "/fake-home/.mattstack/user/.git": "gitdir", "/fake-home/.mattstack/user/.git/config": '[remote "origin"]\n\turl = https://github.com/someone-else/other.git\n' },
    });
    const { ctx } = makeCtx(p, { intent: restoreIntent, secrets: fakeSecrets(fakeAgeKeySeamWithKey()) });

    expect((await homeRestoreStep.run(ctx)).state).toBe("failed");
  });
});

// ─── team.create ─────────────────────────────────────────────────────────────

function gitExecFor(remote: string, pushResult: ExecResult = ok("main -> main")): Probes["exec"] {
  return async (argv) => {
    const [bin, sub] = argv;
    if (bin === "git" && sub === "init") return ok();
    if (bin === "git" && sub === "remote" && argv[2] === "add") return ok();
    if (bin === "git" && sub === "add") return ok();
    if (bin === "git" && sub === "commit") return ok();
    if (bin === "git" && sub === "push") return pushResult;
    if (bin === "git" && sub === "remote" && argv[2] === "set-url") return ok();
    if (bin === "gh" && argv[1] === "api") return ok(JSON.stringify({ login: "alice" }));
    return ok();
  };
}

describe("team.create", () => {
  test("applies: explicit create intent, or team-of-one with no intent and no discovered team", () => {
    const { ctx: viaIntent } = makeCtx(fakeProbes(), { intent: { v: 1, at: "", mode: "create", team: { slug: "acme", name: "Acme", remote: "https://github.com/acme/x.git", others: false } } });
    expect(teamCreateStep.applies(viaIntent)).toBe(true);

    const { ctx: teamOfOneFresh } = makeCtx(fakeProbes(), { teamOfOne: true, intent: null, team: { slug: "", name: "", mode: "none" } });
    expect(teamCreateStep.applies(teamOfOneFresh)).toBe(true);

    const { ctx: teamOfOneWithTeam } = makeCtx(fakeProbes(), { teamOfOne: true, intent: null, team: { slug: "acme", name: "Acme", mode: "none" } });
    expect(teamCreateStep.applies(teamOfOneWithTeam)).toBe(false);

    const { ctx: notTeamOfOne } = makeCtx(fakeProbes());
    expect(teamCreateStep.applies(notTeamOfOne)).toBe(false);
  });

  test("team-of-one, no RT_TEAM_REMOTE, gh unauthenticated -> honest skip (never throws remote-required)", async () => {
    const p = fakeProbes({
      home: "/fake-home",
      env: {},
      exec: async (argv) => (argv[0] === "gh" ? { code: 1, stdout: "", stderr: "not logged in" } : ok()),
    });
    const { ctx } = makeCtx(p, { teamOfOne: true, intent: null, team: { slug: "", name: "", mode: "none" } });

    const outcome = await teamCreateStep.run(ctx);
    expect(outcome).toEqual({ state: "skipped", detail: "no git remote available (set RT_TEAM_REMOTE or run gh auth login)" });
  });

  test("team-of-one with RT_TEAM_REMOTE -> creates and publishes the zone", async () => {
    const remote = "https://github.com/acme/mattstack-team-personal.git";
    const p = fakeProbes({ home: "/fake-home", env: { RT_TEAM_REMOTE: remote }, exec: gitExecFor(remote) });
    const { ctx } = makeCtx(p, { teamOfOne: true, intent: null, team: { slug: "", name: "", mode: "none" } });

    const outcome = await teamCreateStep.run(ctx);
    expect(outcome.state).toBe("done");
    expect(p.exists("/fake-home/.mattstack/teams/personal/mattstack/mattstack.jsonc")).toBe(true);
  });

  test("idempotent re-run: a zone already scaffolded and pushed reports done again without re-scaffolding", async () => {
    const remote = "https://github.com/acme/mattstack-team-personal.git";
    const p = fakeProbes({ home: "/fake-home", env: { RT_TEAM_REMOTE: remote }, exec: gitExecFor(remote) });
    const { ctx } = makeCtx(p, { teamOfOne: true, intent: null, team: { slug: "", name: "", mode: "none" } });

    expect((await teamCreateStep.run(ctx)).state).toBe("done");
    const secondCtx = makeCtx(p, { teamOfOne: true, intent: null, team: { slug: "", name: "", mode: "none" } }).ctx;
    expect((await teamCreateStep.run(secondCtx)).state).toBe("done");
  });

  test("push-denied -> failed with a credentials remedy, from an explicit create intent", async () => {
    const remote = "https://github.com/acme/mattstack-team-acme.git";
    const denied: ExecResult = { code: 128, stdout: "", stderr: "remote: Permission denied (publickey)." };
    expect(AUTH_FAILURE_PATTERN.test(denied.stderr)).toBe(true);
    const p = fakeProbes({ home: "/fake-home", exec: gitExecFor(remote, denied) });
    const { ctx } = makeCtx(p, {
      intent: { v: 1, at: "", mode: "create", team: { slug: "acme", name: "Acme", remote, others: false } },
    });

    const outcome = await teamCreateStep.run(ctx);
    expect(outcome.state).toBe("failed");
    expect((outcome as { remedy?: string }).remedy).toBe("Check your push access to the team repo, then Retry");
  });
});

// ─── team.join ───────────────────────────────────────────────────────────────

const joinPointer = { v: 1 as const, team: "acme", name: "Acme", remote: "https://github.com/acme/mattstack-team-acme.git", owner: "bob", forge: "github", createdAt: "2026-01-01T00:00:00Z" };
const joinIntent: SetupIntent = { v: 1, at: "", mode: "join", join: { id: "a".repeat(32), keyB64: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"), pointer: joinPointer } };

/** joinRedeem reads its resume state straight off `p` (readIntent(p)), not off `ctx.intent` — every fake probe below must carry the intent file too, not just the ApplyContext field. */
function intentFile(home: string, intent: SetupIntent): Record<string, string> {
  return { [intentPath(home)]: JSON.stringify(intent) };
}

describe("team.join", () => {
  test("applies only when intent.mode is join", () => {
    const { ctx: joining } = makeCtx(fakeProbes(), { intent: joinIntent });
    expect(teamJoinStep.applies(joining)).toBe(true);
    const { ctx: notJoining } = makeCtx(fakeProbes());
    expect(teamJoinStep.applies(notJoining)).toBe(false);
  });

  test("happy path: clones, redeems, and reports done", async () => {
    const p = fakeProbes({
      home: "/fake-home",
      files: intentFile("/fake-home", joinIntent),
      exec: async (argv) => {
        if (argv[0] === "git" && argv[1] === "clone") return ok();
        if (argv[0] === "gh" && argv[1] === "api") return ok(JSON.stringify({ login: "carol" }));
        return ok();
      },
    });
    const relay: RelayClient = { ...fakeRelay, redeem: async () => "redeemed", reply: async () => {} };
    const { ctx } = makeCtx(p, { intent: joinIntent, relay, secrets: fakeSecrets(fakeAgeKeySeamWithKey()) });

    const outcome = await teamJoinStep.run(ctx);
    expect(outcome.state).toBe("done");
    expect((outcome as { detail?: string }).detail).toContain("Joined Acme");
  });

  test("idempotent re-run: already cloned + relay says 'already' resumes cleanly instead of throwing invite-unknown", async () => {
    const dir = "/fake-home/.mattstack/teams/acme";
    const p = fakeProbes({
      home: "/fake-home",
      dirs: { [dir]: [".git"], [`${dir}/.git`]: [] },
      files: {
        [`${dir}/.git`]: "gitdir",
        [`${dir}/.git/config`]: `[remote "origin"]\n\turl = ${joinPointer.remote}\n`,
        ...intentFile("/fake-home", joinIntent),
      },
      exec: async (argv) => (argv[0] === "gh" && argv[1] === "api" ? ok(JSON.stringify({ login: "carol" })) : ok()),
    });
    const relay: RelayClient = { ...fakeRelay, redeem: async () => "already", reply: async () => {} };
    const { ctx } = makeCtx(p, { intent: joinIntent, relay, secrets: fakeSecrets(fakeAgeKeySeamWithKey()) });

    const outcome = await teamJoinStep.run(ctx);
    expect(outcome.state).toBe("done");
  });

  test("access denied -> failed, remedy asks the owner to grant access", async () => {
    const p = fakeProbes({
      home: "/fake-home",
      files: intentFile("/fake-home", joinIntent),
      exec: async (argv) => (argv[0] === "git" && argv[1] === "clone" ? { code: 128, stdout: "", stderr: "remote: Permission denied to bob." } : ok()),
    });
    const { ctx } = makeCtx(p, { intent: joinIntent, secrets: fakeSecrets(fakeAgeKeySeamWithKey()) });

    const outcome = await teamJoinStep.run(ctx);
    expect(outcome.state).toBe("failed");
    expect((outcome as { detail: string }).detail).toContain("you don't have access yet");
    expect((outcome as { remedy?: string }).remedy).toBe("Ask the owner to grant access, then Retry");
  });
});

// ─── secrets.write ───────────────────────────────────────────────────────────

describe("secrets.write", () => {
  function stagedProbes(staged: Record<string, Record<string, string>>): ReturnType<typeof fakeProbes> {
    const dir = stagingDir("/fake-home");
    const files: Record<string, string> = {};
    for (const [domain, kv] of Object.entries(staged)) files[`${dir}/${domain}.json`] = JSON.stringify(kv);
    return fakeProbes({ home: "/fake-home", files, dirs: { [dir]: Object.keys(staged).map((d) => `${d}.json`) } });
  }

  test("happy path: drains every staged domain through the real writer, including a team-<slug>-<domain> shape", async () => {
    const p = stagedProbes({ rt: { token: "abc" }, "team-acme-linear": { apiKey: "xyz" } });
    const { ctx } = makeCtx(p);

    const outcome = await secretsWriteStep.run(ctx);
    expect(outcome).toEqual({ state: "done", detail: "2 staged secrets written" });
    expect(p.readDir(stagingDir("/fake-home"))).toEqual([]); // drained
  });

  test("idempotent re-run: nothing staged the second time reports an honest zero, not a re-write", async () => {
    const p = stagedProbes({ rt: { token: "abc" } });
    const { ctx } = makeCtx(p);

    await secretsWriteStep.run(ctx);
    const outcome = await secretsWriteStep.run(ctx);
    expect(outcome).toEqual({ state: "done", detail: "nothing staged" });
  });

  test("no age key yet -> failed, remedy points back at home.init", async () => {
    const p = stagedProbes({ rt: { token: "abc" } });
    const { ctx } = makeCtx(p, { secrets: fakeSecrets(fakeAgeKeySeamAbsent()) });

    const outcome = await secretsWriteStep.run(ctx);
    expect(outcome.state).toBe("failed");
    expect((outcome as { remedy?: string }).remedy).toBe("home.init did not mint a key — Retry from home.init");
  });
});

// ─── path.link, settings.seed, repos.clone, intercepts.install ─────────────
// These four touch real HOME-relative fs/settings state (dev-mode.ts's
// installRtBinary, shell-integration.ts, the settings resolver, repo-index.ts)
// rather than going purely through Probes — same posture as
// lib/deps/__tests__/links.test.ts, which this borrows its bundle fixture from.

const LOCK = {
  schema: 1,
  arch: "arm64",
  tools: [
    { name: "fast-browser", version: "0.1.0", license: "MIT", url: "https://x/fb.tgz", sha256: "b".repeat(64), archive: "npm", extract: "package", bundlePath: `${HELPERS_DIR}/fast-browser`, exec: [`${HELPERS_DIR}/fast-browser/bin/fb`], exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "gitq", version: "0.1.0", license: "MIT", url: "https://x/gitq.tgz", sha256: "c".repeat(64), archive: "raw", extract: "", bundlePath: `${HELPERS_DIR}/gitq`, exec: [`${HELPERS_DIR}/gitq`], exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper" },
    { name: "deck", version: "0.1.0", license: "MIT", url: "https://x/deck.tgz", sha256: "d".repeat(64), archive: "raw", extract: "", bundlePath: `${HELPERS_DIR}/deck`, exec: [`${HELPERS_DIR}/deck`], exposeByDefault: true, entitlements: "none", status: "bundled", kind: "helper" },
  ],
};

describe("path.link / settings.seed / repos.clone / intercepts.install (real HOME)", () => {
  const origHome = process.env.HOME;
  let home: string;
  let appRoot: string;

  beforeEach(() => {
    bundleLayoutTest.resetBundleLayoutMemo();
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-steps-a-home-")));
    process.env.HOME = home;

    appRoot = join(realpathSync(mkdtempSync(join(tmpdir(), "rt-steps-a-app-"))), "mattstack.app");
    mkdirSync(join(appRoot, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(appRoot, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(appRoot, HELPERS_DIR, "fast-browser", "bin"), { recursive: true });
    writeFileSync(join(appRoot, "Contents", "Info.plist"), "<plist/>");
    writeFileSync(join(appRoot, "Contents", "Resources", "deps.lock"), JSON.stringify(LOCK));
    writeFileSync(join(appRoot, RT_BUNDLE_PATH), "rt-binary");
    writeFileSync(join(appRoot, HELPERS_DIR, "fast-browser", "bin", "fb"), "fb-binary");
    writeFileSync(join(appRoot, HELPERS_DIR, "gitq"), "gitq-binary");
    writeFileSync(join(appRoot, HELPERS_DIR, "deck"), "deck-binary");
    setSetting("mattstack.appPath", appRoot, "machine");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    bundleLayoutTest.resetBundleLayoutMemo();
  });

  function bundleProbe(overrides: Partial<Parameters<typeof fakeProbes>[0]> = {}): ReturnType<typeof fakeProbes> {
    return fakeProbes({
      home,
      ...overrides,
      files: {
        [join(appRoot, HELPERS_DIR, "fast-browser", "bin", "fb")]: "fb-binary",
        [join(appRoot, HELPERS_DIR, "gitq")]: "gitq-binary",
        [join(appRoot, HELPERS_DIR, "deck")]: "deck-binary",
        [join(appRoot, RT_BUNDLE_PATH)]: "rt-binary",
        ...overrides.files,
      },
      dirs: { [appRoot]: [], [join(appRoot, HELPERS_DIR, "fast-browser")]: ["bin"], ...overrides.dirs },
    });
  }

  test("path.link: links fast-browser/gitq/deck, skips rt when the dev-mode wrapper owns ~/.local/bin/rt, installs shell + zshenv precedence", async () => {
    const p = bundleProbe({ files: { [linkPath(home, "rt")]: "#!/bin/sh\nexec bun run cli.ts \"$@\"\n" } });
    const { ctx, logs } = makeCtx(p);

    const outcome = await pathLinkStep.run(ctx);
    expect(outcome.state).toBe("done");
    expect((outcome as { detail: string }).detail).toContain("linked: fast-browser, gitq, deck");
    expect((outcome as { detail: string }).detail).toContain("skipped: rt");
    expect(logs.some((l) => l.line.includes("dev-mode wrapper"))).toBe(true);

    // real fs side effects
    expect(getSetting<string>("mattstack.appPath").value).toBe(appRoot); // untouched by this step
    expect(existsSync(join(home, ".zshenv"))).toBe(true);
    expect(readFileSync(join(home, ".zshenv"), "utf8")).toContain("mattstack — PATH precedence");
  });

  test("path.link: idempotent re-run reports every tool 'already' linked and the shell blocks are not duplicated", async () => {
    const p = bundleProbe({ files: { [linkPath(home, "rt")]: "#!/bin/sh\nexec bun run cli.ts \"$@\"\n" } });
    const { ctx: firstCtx } = makeCtx(p);
    await pathLinkStep.run(firstCtx);

    const { ctx: secondCtx } = makeCtx(p);
    const outcome = await pathLinkStep.run(secondCtx);
    expect(outcome.state).toBe("done");
    expect((outcome as { detail: string }).detail).toContain("linked: fast-browser, gitq, deck");

    const zshenv = readFileSync(join(home, ".zshenv"), "utf8");
    expect(zshenv.split("mattstack — PATH precedence").length).toBe(2); // exactly one occurrence
  });

  test("settings.seed: writes mattstack.appPath from ctx.appPath and detects a repo root that exists", async () => {
    const githubRoot = join(home, "Documents", "GitHub");
    const p = fakeProbes({ home, dirs: { [githubRoot]: [] } });
    const { ctx } = makeCtx(p, { appPath: appRoot });

    const outcome = await settingsSeedStep.run(ctx);
    expect(outcome.state).toBe("done");
    expect(getSetting<string>("mattstack.appPath").value).toBe(appRoot);
    expect(getSetting<string[]>("rt.repoRoots").value).toEqual([githubRoot]);
  });

  test("settings.seed: a transient (/Volumes) app root is refused — failed, nothing written", async () => {
    const transientRoot = "/Volumes/mattstack/mattstack.app";
    const { ctx } = makeCtx(fakeProbes({ home }), { appPath: transientRoot });

    const before = getSetting<string>("mattstack.appPath").value;
    const outcome = await settingsSeedStep.run(ctx);
    expect(outcome.state).toBe("failed");
    expect((outcome as { detail: string }).detail).toContain("drag mattstack.app to /Applications");
    expect((outcome as { remedy?: string }).remedy).toBe("Move mattstack.app to /Applications and relaunch it");
    expect(getSetting<string>("mattstack.appPath").value).toBe(before); // untouched
  });

  test("settings.seed: rt.repoRoots already set is left alone (existing wins over detected)", async () => {
    setSetting("rt.repoRoots", ["/already/configured"], "machine");
    const githubRoot = join(home, "Documents", "GitHub");
    const p = fakeProbes({ home, dirs: { [githubRoot]: [] } });
    const { ctx } = makeCtx(p, { appPath: null });

    await settingsSeedStep.run(ctx);
    expect(getSetting<string[]>("rt.repoRoots").value).toEqual(["/already/configured"]);
  });

  test("repos.clone: clones a missing identity with the expected argv, skips an existing dir", async () => {
    setSetting("rt.repoRoots", [join(home, "code")], "machine");
    mkdirSync(join(home, "code"), { recursive: true });
    const dest = join(home, "code", "assured-dev");

    const p = fakeProbes({ home, exec: async () => ok() });
    const { ctx } = makeCtx(p, { snapshot: { slug: "acme", integrations: {}, trackingIdentities: ["gitlab.com/assured/assured-dev"], marketplaces: [], plugins: [], remote: null } });

    const outcome = await reposCloneStep.run(ctx);
    expect(outcome).toEqual({ state: "done", detail: "cloned 1, present 0, failed 0" });
    expect(p.calls.exec).toEqual([["git", "clone", "https://gitlab.com/assured/assured-dev.git", dest]]);
  });

  test("repos.clone: an already-present directory is skipped (idempotent re-run never re-clones)", async () => {
    setSetting("rt.repoRoots", [join(home, "code")], "machine");
    const dest = join(home, "code", "assured-dev");

    const p = fakeProbes({ home, dirs: { [dest]: [] }, exec: async () => ok() });
    const { ctx } = makeCtx(p, { snapshot: { slug: "acme", integrations: {}, trackingIdentities: ["gitlab.com/assured/assured-dev"], marketplaces: [], plugins: [], remote: null } });

    const outcome = await reposCloneStep.run(ctx);
    expect(outcome).toEqual({ state: "done", detail: "cloned 0, present 1, failed 0" });
    expect(p.calls.exec).toEqual([]);
  });

  test("repos.clone: no configured repo root -> failed", async () => {
    const p = fakeProbes({ home });
    const { ctx } = makeCtx(p);

    expect(await reposCloneStep.run(ctx)).toEqual({ state: "failed", detail: "no repo root" });
  });

  test("intercepts.install: an empty repo index reports 'no commands to shim'", async () => {
    const { ctx } = makeCtx(fakeProbes({ home }));
    const outcome = await interceptsInstallStep.run(ctx);
    expect(outcome).toEqual({ state: "done", detail: "no commands to shim" });
  });
});
