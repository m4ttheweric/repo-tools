import { describe, test, expect } from "bun:test";
import { join } from "path";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";
import { createTeam, scaffoldFiles } from "../create.ts";
import { UserActionableError } from "../../setup/errors.ts";
import { readIntent } from "../../setup/intent.ts";
import { createRealProbes } from "../../setup/probes.ts";
import { getSetting } from "../../settings/resolve.ts";
import type { AgeExecResult, AgeKeySeam } from "../../home/age-key.ts";

const FAKE_PUBLIC_KEY = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const FAKE_PRIVATE_KEY = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";

/** An age key already in the keychain — ensureAgeKey only derives its public half, never mints. */
class FakeAgeKeySeam implements AgeKeySeam {
  calls: string[][] = [];
  async run(cmd: string[]): Promise<AgeExecResult> {
    this.calls.push(cmd);
    if (cmd[1] === "find-generic-password") return { code: 0, stdout: `${FAKE_PRIVATE_KEY}\n`, stderr: "" };
    if (cmd[0] === "age-keygen" && cmd[1] === "-y") return { code: 0, stdout: `${FAKE_PUBLIC_KEY}\n`, stderr: "" };
    throw new Error(`FakeAgeKeySeam: unexpected call ${cmd.join(" ")}`);
  }
}

/** `settings.team.jsonc`'s content is a one-line header comment followed by the JSON body. */
function parseSettingsBody(content: string): Record<string, unknown> {
  return JSON.parse(content.split("\n").slice(1).join("\n"));
}

type FakeExecResult = { code: number; stdout: string; stderr: string };
type Intercept = (argv: string[], opts?: { cwd?: string }) => FakeExecResult | undefined;

/**
 * `createTeam`'s idempotency/resume logic reads `.git` and `.git/config` off
 * disk (mirroring `team-settings.ts`'s own `readTeamSnapshot`) — real git
 * writes both as a side effect of `init`/`remote add`, which a plain fake
 * exec has no side effect for on its own. This simulates just enough of
 * that for a resumed `createTeam` call to see what a previous call did.
 * `intercept` lets a test override one specific call (e.g. fail `git init`
 * once) while every other recognized git call still gets its default,
 * successful, side-effecting simulation.
 */
function gitAwareFakeProbes(home: string, intercept?: Intercept) {
  const p = fakeProbes({
    home,
    exec: (argv, execOpts) => {
      const override = intercept?.(argv, execOpts);
      if (override) return override;

      if (argv[0] === "git" && argv[1] === "init" && execOpts?.cwd) {
        p.mkdirp(join(execOpts.cwd, ".git"));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "git" && argv[1] === "remote" && argv[2] === "add" && execOpts?.cwd) {
        p.writeFile(join(execOpts.cwd, ".git", "config"), `[remote "origin"]\n\turl = ${argv[4]}\n`);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return p;
}

describe("scaffoldFiles", () => {
  test("gitlab remote: forge + board.gitlabHost both present", () => {
    const files = scaffoldFiles("acme", "Acme", "https://gitlab.example.com/g/acme.git");
    const settings = parseSettingsBody(files["mattstack/settings.team.jsonc"]!);
    expect((settings["mattstack.integrations"] as any).forge).toEqual({ host: "gitlab.example.com", provider: "gitlab" });
    expect(settings["board.gitlabHost"]).toBe("gitlab.example.com");
  });

  test("github remote: no board.gitlabHost key at all", () => {
    const files = scaffoldFiles("acme", "Acme", "https://github.com/acme/mattstack-team-acme.git");
    const settings = parseSettingsBody(files["mattstack/settings.team.jsonc"]!);
    expect((settings["mattstack.integrations"] as any).forge).toEqual({ host: "github.com", provider: "github" });
    expect("board.gitlabHost" in settings).toBe(false);
  });

  test("board.projects and board.members are never written — an empty array would flip their store-ownership latch", () => {
    for (const remote of ["https://github.com/acme/repo.git", "https://gitlab.example.com/g/acme.git"]) {
      const settings = parseSettingsBody(scaffoldFiles("acme", "Acme", remote)["mattstack/settings.team.jsonc"]!);
      expect("board.projects" in settings).toBe(false);
      expect("board.members" in settings).toBe(false);
      expect(settings["board.title"]).toBe("Acme");
    }
  });

  test("seeds .sops.yaml with the given recipients, not empty", () => {
    const files = scaffoldFiles("acme", "Acme", "https://github.com/acme/repo.git", [FAKE_PUBLIC_KEY]);
    expect(files[".sops.yaml"]).toContain(`age: ${FAKE_PUBLIC_KEY}`);
  });

  test("mattstack.jsonc names the owner parsed from the remote", () => {
    const files = scaffoldFiles("acme", "Acme", "https://github.com/acme/mattstack-team-acme.git");
    expect(JSON.parse(files["mattstack/mattstack.jsonc"]!)).toEqual({ role: "team", namespace: "acme", org: "acme" });
  });
});

describe("createTeam", () => {
  test("argv sequence is init → remote add → add → commit, never push", async () => {
    const p = gitAwareFakeProbes("/home/x");
    const result = await createTeam(
      p,
      { name: "Acme", remote: "https://github.com/acme/mattstack-team-acme.git", others: false },
      new FakeAgeKeySeam(),
    );

    expect(result).toEqual({
      slug: "acme",
      name: "Acme",
      remote: "https://github.com/acme/mattstack-team-acme.git",
      dir: join("/home/x", ".mattstack", "teams", "acme"),
      created: true,
    });

    expect(p.calls.exec).toEqual([
      ["git", "init", "-b", "main"],
      ["git", "remote", "add", "origin", "https://github.com/acme/mattstack-team-acme.git"],
      ["git", "add", "-A"],
      ["git", "commit", "-m", "team: scaffold acme"],
    ]);
  });

  test("writes the setup intent for the daemon/apply to resume from", async () => {
    const p = gitAwareFakeProbes("/home/x");
    await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: true }, new FakeAgeKeySeam());

    const intent = readIntent(p);
    expect(intent?.mode).toBe("create");
    expect(intent?.team).toEqual({ slug: "acme", name: "Acme", remote: "https://github.com/acme/repo.git", others: true });
  });

  test("missing remote and --create-repo throws remote-required", async () => {
    const p = gitAwareFakeProbes("/home/x");
    await expect(createTeam(p, { name: "Acme", remote: null, others: false }, new FakeAgeKeySeam())).rejects.toMatchObject({
      code: "remote-required",
    });
    expect(p.calls.exec).toEqual([]);
  });

  test("--create-repo o creates o/mattstack-team-<slug> via gh and the printed URL becomes the remote", async () => {
    const p = gitAwareFakeProbes("/home/x", (argv) => (argv[0] === "gh" ? { code: 0, stdout: "https://github.com/o/mattstack-team-acme\n", stderr: "" } : undefined));
    const result = await createTeam(p, { name: "Acme", remote: null, createRepoOwner: "o", others: false }, new FakeAgeKeySeam());

    expect(p.calls.exec[0]).toEqual(["gh", "repo", "create", "o/mattstack-team-acme", "--private"]);
    expect(result.remote).toBe("https://github.com/o/mattstack-team-acme");
  });

  test("second call with the same remote is idempotent: created:false, zero git calls, intent (re)written", async () => {
    const p = gitAwareFakeProbes("/home/x");
    await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());
    p.calls.exec.length = 0;
    const writePathsBefore = Object.keys(p.calls.writes).sort();

    const result = await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());

    expect(result.created).toBe(false);
    expect(result.remote).toBe("https://github.com/acme/repo.git");
    expect(p.calls.exec).toEqual([]);
    // The intent file is refreshed (finding 8), but no NEW path is ever written on the idempotent path — no scaffold file is rewritten.
    expect(Object.keys(p.calls.writes).sort()).toEqual(writePathsBefore);
    expect(readIntent(p)?.team?.remote).toBe("https://github.com/acme/repo.git");
  });

  test("existing dir with a different remote throws team-exists", async () => {
    const p = gitAwareFakeProbes("/home/x");
    await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());

    await expect(
      createTeam(p, { name: "Acme", remote: "https://github.com/other/repo.git", others: false }, new FakeAgeKeySeam()),
    ).rejects.toMatchObject({ code: "team-exists" });
  });

  describe("partial-zone resume (R-T16-b)", () => {
    test("--remote path: git init fails, then a re-run with the same args finishes the zone", async () => {
      let initCalls = 0;
      const p = gitAwareFakeProbes("/home/x", (argv) => {
        if (argv[0] === "git" && argv[1] === "init") {
          initCalls += 1;
          if (initCalls === 1) return { code: 128, stdout: "", stderr: "fatal: could not create work tree dir" };
        }
        return undefined;
      });

      await expect(
        createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam()),
      ).rejects.toBeInstanceOf(UserActionableError);

      // Second call succeeds and finishes the zone.
      const result = await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());
      expect(result.created).toBe(true);
      expect(result.remote).toBe("https://github.com/acme/repo.git");
      expect(initCalls).toBe(2);
    });

    test("--create-repo path: gh succeeds, git init then fails, and a resume finishes WITHOUT calling gh a second time", async () => {
      let initCalls = 0;
      const p = gitAwareFakeProbes("/home/x", (argv) => {
        if (argv[0] === "gh") return { code: 0, stdout: "https://github.com/o/mattstack-team-acme\n", stderr: "" };
        if (argv[0] === "git" && argv[1] === "init") {
          initCalls += 1;
          if (initCalls === 1) return { code: 128, stdout: "", stderr: "fatal: could not create work tree dir" };
        }
        return undefined;
      });

      await expect(
        createTeam(p, { name: "Acme", remote: null, createRepoOwner: "o", others: false }, new FakeAgeKeySeam()),
      ).rejects.toMatchObject({ code: "git-init-failed" });

      const result = await createTeam(p, { name: "Acme", remote: null, createRepoOwner: "o", others: false }, new FakeAgeKeySeam());

      expect(result.created).toBe(true);
      expect(result.remote).toBe("https://github.com/o/mattstack-team-acme");
      expect(initCalls).toBe(2);
      const ghCalls = p.calls.exec.filter((c) => c[0] === "gh");
      expect(ghCalls).toHaveLength(1); // never re-created the already-existing gh repo
    });

    test("never returns remote:'' — an incomplete zone is always a typed error, not a silent success", async () => {
      const p = gitAwareFakeProbes("/home/x", (argv) => (argv[0] === "git" && argv[1] === "init" ? { code: 1, stdout: "", stderr: "boom" } : undefined));

      let thrown: unknown;
      try {
        await createTeam(p, { name: "Acme", remote: "https://github.com/acme/repo.git", others: false }, new FakeAgeKeySeam());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(UserActionableError);
      expect((thrown as UserActionableError).code).not.toBe("");
    });
  });

  describe("populated-zone re-run is non-destructive (R-T16-b / finding 9)", () => {
    test("existing settings, a multi-recipient .sops.yaml, and a secret file all survive an idempotent re-run", async () => {
      const p = gitAwareFakeProbes("/home/x");
      const dir = join("/home/x", ".mattstack", "teams", "acme");
      const remote = "https://github.com/acme/repo.git";

      const customSettings = '// hand-edited\n{"board.title":"Acme (real)"}\n';
      const customSops = "creation_rules:\n  - path_regex: mattstack/secrets/.*\n    age: age1aaa,age1bbb\n";
      const secretBlob = '{"rt":{"switchboardAdminToken":"sops-encrypted-blob"}}';

      p.writeFile(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
      p.writeFile(join(dir, "mattstack", "mattstack.jsonc"), '{"role":"team","namespace":"acme","org":"acme"}\n');
      p.writeFile(join(dir, "mattstack", "settings.team.jsonc"), customSettings);
      p.writeFile(join(dir, ".sops.yaml"), customSops);
      p.writeFile(join(dir, "mattstack", "secrets", "rt.json"), secretBlob);
      p.calls.writes = {};
      p.calls.exec.length = 0;

      const result = await createTeam(p, { name: "Acme", remote, others: false }, new FakeAgeKeySeam());

      expect(result.created).toBe(false);
      expect(p.calls.exec).toEqual([]);
      // The only permitted write on this path is the runtime intent — every zone file is untouched.
      expect(Object.keys(p.calls.writes)).toEqual(["/home/x/.mattstack/rt/setup-intent.json"]);
      expect(p.readFile(join(dir, "mattstack", "settings.team.jsonc"))).toBe(customSettings);
      expect(p.readFile(join(dir, ".sops.yaml"))).toBe(customSops);
      expect(p.readFile(join(dir, "mattstack", "secrets", "rt.json"))).toBe(secretBlob);
    });
  });
});

describe("createTeam (real fs + real git, fake age key only) — R-T16-a / finding 9b", () => {
  test("a pre-existing board config's ownership latch is not flipped, and the on-disk .sops.yaml carries the creator's real key", async () => {
    const origHome = process.env.HOME;
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rt-team-create-e2e-")));
    process.env.HOME = home;
    try {
      const p = createRealProbes();
      const result = await createTeam(
        p,
        { name: "Acme", remote: "https://github.com/acme/repo.git", others: false },
        new FakeAgeKeySeam(),
      );

      expect(result.created).toBe(true);
      expect(getSetting<unknown[]>("board.projects").value).toBeUndefined();
      expect(getSetting<unknown[]>("board.members").value).toBeUndefined();
      expect(getSetting<string>("board.title").value).toBe("Acme");

      const sopsYaml = p.readFile(join(result.dir, ".sops.yaml"));
      expect(sopsYaml).toContain(`age: ${FAKE_PUBLIC_KEY}`);
    } finally {
      process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
