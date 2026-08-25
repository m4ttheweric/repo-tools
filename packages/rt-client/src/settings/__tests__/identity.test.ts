/**
 * lib/settings/identity.ts — repo identity normalization + async derivation
 * (RT-47). Per-test HOME (mkdtemp) since the override tests write a machine
 * store file; deriveRepoIdentity tests use a real `git init` repo rather than
 * mocking git.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { runCapture } from "../exec.ts";
import { machineSettingsPath } from "../paths.ts";
import { normalizeRemote, identityFromRemote, deriveRepoIdentity, clearIdentityMemo } from "../identity.ts";
import { serializeIdentity, parseIdentity, type RepoIdentity } from "../identity.ts";

describe("settings/identity", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-settings-identity-"));
    process.env.HOME = home;
    clearIdentityMemo();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    clearIdentityMemo();
  });

  describe("normalizeRemote", () => {
    test("https remote", () => {
      expect(normalizeRemote("https://gitlab.com/acme/acme-dev.git")).toBe(
        "gitlab.com/acme/acme-dev",
      );
    });

    test("scp-style git@ remote normalizes the same as https", () => {
      expect(normalizeRemote("git@gitlab.com:acme/acme-dev.git")).toBe(
        "gitlab.com/acme/acme-dev",
      );
    });

    test("ssh:// remote, no .git suffix", () => {
      expect(normalizeRemote("ssh://git@github.com/m4ttstack/rt")).toBe("github.com/m4ttstack/rt");
    });

    test("strips embedded credentials", () => {
      expect(normalizeRemote("https://user:pass@host/x/y")).toBe("host/x/y");
    });

    test("local path remote yields null", () => {
      expect(normalizeRemote("/private/tmp/foo")).toBeNull();
    });

    test("host is lowercased, path case is preserved", () => {
      expect(normalizeRemote("HTTPS://GitLab.com/A/B")).toBe("gitlab.com/A/B");
    });

    test("unrecognized garbage yields null", () => {
      expect(normalizeRemote("not a remote at all")).toBeNull();
    });
  });

  describe("identityFromRemote", () => {
    test("falls back to normalizeRemote when no override matches", () => {
      expect(identityFromRemote("https://gitlab.com/acme/acme-dev.git")).toEqual({
        kind: "remote",
        id: "gitlab.com/acme/acme-dev",
      });
    });

    test("a local-path remote yields null (not a usable remote)", () => {
      expect(identityFromRemote("/private/tmp/foo")).toBeNull();
    });

    test("exact remote match in the machine store's rt.repoIdentityOverrides wins", () => {
      mkdirSync(dirname(machineSettingsPath()), { recursive: true });
      writeFileSync(
        machineSettingsPath(),
        JSON.stringify({
          "rt.repoIdentityOverrides": {
            "/private/tmp/foo": "gitlab.com/acme/acme-dev",
          },
        }),
      );

      // Without the override this local-path remote would normalize to null.
      expect(identityFromRemote("/private/tmp/foo")).toEqual({
        kind: "remote",
        id: "gitlab.com/acme/acme-dev",
      });
    });

    test("override map present but remote not in it still falls through to normalizeRemote", () => {
      mkdirSync(dirname(machineSettingsPath()), { recursive: true });
      writeFileSync(
        machineSettingsPath(),
        JSON.stringify({
          "rt.repoIdentityOverrides": {
            "some-other-remote": "gitlab.com/other/repo",
          },
        }),
      );

      expect(identityFromRemote("https://gitlab.com/acme/acme-dev.git")).toEqual({
        kind: "remote",
        id: "gitlab.com/acme/acme-dev",
      });
    });
  });

  describe("deriveRepoIdentity", () => {
    async function initRepo(remote?: string): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), "rt-settings-identity-repo-"));
      await runCapture(["git", "init", "-q"], { cwd: dir });
      if (remote) {
        await runCapture(["git", "remote", "add", "origin", remote], { cwd: dir });
      }
      return dir;
    }

    test("derives identity from a real repo's remote.origin.url", async () => {
      const dir = await initRepo("https://gitlab.com/acme/acme-dev.git");
      try {
        expect(await deriveRepoIdentity(dir)).toEqual({
          kind: "remote",
          id: "gitlab.com/acme/acme-dev",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a repo with no remote falls back to a path-kind identity (main worktree realpath)", async () => {
      const dir = await initRepo();
      try {
        expect(await deriveRepoIdentity(dir)).toEqual({ kind: "path", id: realpathSync(dir) });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("routes through identityFromRemote so an override applies to derivation too", async () => {
      const dir = await initRepo("/private/tmp/some-local-remote");
      mkdirSync(dirname(machineSettingsPath()), { recursive: true });
      writeFileSync(
        machineSettingsPath(),
        JSON.stringify({
          "rt.repoIdentityOverrides": {
            "/private/tmp/some-local-remote": "gitlab.com/pinned/fork",
          },
        }),
      );

      try {
        expect(await deriveRepoIdentity(dir)).toEqual({ kind: "remote", id: "gitlab.com/pinned/fork" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("memoizes per path: a remote change after the first call does not change the result", async () => {
      const dir = await initRepo("https://gitlab.com/acme/acme-dev.git");
      try {
        const first = await deriveRepoIdentity(dir);
        expect(first).toEqual({ kind: "remote", id: "gitlab.com/acme/acme-dev" });

        await runCapture(["git", "remote", "set-url", "origin", "https://gitlab.com/other/repo.git"], {
          cwd: dir,
        });

        const second = await deriveRepoIdentity(dir);
        expect(second).toEqual(first);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a path-kind result is not memoized: adding a remote after a path-kind result is picked up on the next call, no clearIdentityMemo needed", async () => {
      const dir = await initRepo();
      try {
        const first = await deriveRepoIdentity(dir);
        expect(first.kind).toBe("path");

        await runCapture(["git", "remote", "add", "origin", "https://gitlab.com/acme/acme-dev.git"], {
          cwd: dir,
        });

        expect(await deriveRepoIdentity(dir)).toEqual({
          kind: "remote",
          id: "gitlab.com/acme/acme-dev",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("clearIdentityMemo forces re-derivation", async () => {
      const dir = await initRepo("https://gitlab.com/acme/acme-dev.git");
      try {
        const first = await deriveRepoIdentity(dir);
        expect(first).toEqual({ kind: "remote", id: "gitlab.com/acme/acme-dev" });

        await runCapture(["git", "remote", "set-url", "origin", "https://gitlab.com/other/repo.git"], {
          cwd: dir,
        });
        clearIdentityMemo();

        const second = await deriveRepoIdentity(dir);
        expect(second).toEqual({ kind: "remote", id: "gitlab.com/other/repo" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("derivation → tagged (fresh git init, no remote at all)", () => {
    test("deriveRepoIdentity falls back to the main worktree realpath, never null", async () => {
      const scratch = mkdtempSync(join(tmpdir(), "rt-id-"));
      try {
        const repo = join(scratch, "no-origin");
        mkdirSync(repo);
        execSync("git init -q -b main", { cwd: repo, stdio: "pipe" });
        execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: repo, stdio: "pipe" });
        clearIdentityMemo();
        const id = await deriveRepoIdentity(repo);
        expect(id.kind).toBe("path");
        expect(id.id).toBe(realpathSync(repo));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    test("a linked worktree of a no-remote repo resolves to the MAIN worktree's realpath, not its own", async () => {
      const scratch = mkdtempSync(join(tmpdir(), "rt-id-wt-"));
      try {
        const main = join(scratch, "main");
        mkdirSync(main);
        execSync("git init -q -b main", { cwd: main, stdio: "pipe" });
        execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: main, stdio: "pipe" });
        const linked = join(scratch, "linked");
        execSync(`git worktree add -q "${linked}" -b feature`, { cwd: main, stdio: "pipe" });
        clearIdentityMemo();
        // The identity of a linked worktree must be the main worktree's realpath —
        // this is what makes every worktree of one repo share a single identity.
        expect(await deriveRepoIdentity(linked)).toEqual({ kind: "path", id: realpathSync(main) });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    test("a --separate-git-dir repo derives its own worktree, never the shared metadata parent", async () => {
      const scratch = mkdtempSync(join(tmpdir(), "rt-id-sep-"));
      try {
        const meta = join(scratch, "meta");
        const a = join(scratch, "a");
        const b = join(scratch, "b");
        mkdirSync(meta);
        execSync(`git init -q -b main --separate-git-dir "${join(meta, "a.git")}" "${a}"`, { stdio: "pipe" });
        execSync(`git init -q -b main --separate-git-dir "${join(meta, "b.git")}" "${b}"`, { stdio: "pipe" });
        clearIdentityMemo();
        // `--git-common-dir/..` would derive `meta` for BOTH repos, merging
        // two unrelated repos into one identity.
        expect(await deriveRepoIdentity(a)).toEqual({ kind: "path", id: realpathSync(a) });
        expect(await deriveRepoIdentity(b)).toEqual({ kind: "path", id: realpathSync(b) });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  });
});

describe("identity wire codec", () => {
  const cases: RepoIdentity[] = [
    { kind: "remote", id: "gitlab.com/group/repo" },
    { kind: "remote", id: "gitlab.com/group/sub/repo" },
    { kind: "path", id: "/Users/matt/Documents/GitHub/x" },
    { kind: "path", id: "/tmp/a dir/with spaces" },
  ];

  test("serialize then parse is the identity function", () => {
    for (const id of cases) expect(parseIdentity(serializeIdentity(id))).toEqual(id);
  });

  test("the serialized form contains no forward slash", () => {
    for (const id of cases) expect(serializeIdentity(id)).not.toContain("/");
  });

  test("serialized form is <kind>:<encoded>", () => {
    expect(serializeIdentity({ kind: "remote", id: "gitlab.com/g/r" }))
      .toBe("remote:gitlab.com%2Fg%2Fr");
  });

  test("parse rejects an unknown kind prefix", () => {
    expect(parseIdentity("bogus:whatever")).toBeNull();
  });

  test("parse rejects a string with no kind prefix", () => {
    expect(parseIdentity("gitlab.com/g/r")).toBeNull();
  });

  test("parse rejects a non-canonical wire — a literal slash must never pass the guard sites that use the wire as one path component", () => {
    expect(parseIdentity("path:../..")).toBeNull();
    expect(parseIdentity("path:/etc/passwd")).toBeNull();
    expect(parseIdentity("remote:gitlab.com/g/r")).toBeNull();
    expect(parseIdentity("path:..%2f..")).toBeNull(); // lowercase hex: not what serializeIdentity emits
  });
});
