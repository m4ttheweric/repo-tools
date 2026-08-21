/**
 * lib/settings/identity.ts — repo identity normalization + async derivation
 * (RT-47). Per-test HOME (mkdtemp) since the override tests write a machine
 * store file; deriveRepoIdentity tests use a real `git init` repo rather than
 * mocking git.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { runCapture } from "../exec.ts";
import { machineSettingsPath } from "../paths.ts";
import { normalizeRemote, identityFromRemote, deriveRepoIdentity, clearIdentityMemo } from "../identity.ts";

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
      expect(normalizeRemote("https://gitlab.com/assured/assured-dev.git")).toBe(
        "gitlab.com/assured/assured-dev",
      );
    });

    test("scp-style git@ remote normalizes the same as https", () => {
      expect(normalizeRemote("git@gitlab.com:assured/assured-dev.git")).toBe(
        "gitlab.com/assured/assured-dev",
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
      expect(identityFromRemote("https://gitlab.com/assured/assured-dev.git")).toBe(
        "gitlab.com/assured/assured-dev",
      );
    });

    test("exact remote match in the machine store's rt.repoIdentityOverrides wins", () => {
      mkdirSync(dirname(machineSettingsPath()), { recursive: true });
      writeFileSync(
        machineSettingsPath(),
        JSON.stringify({
          "rt.repoIdentityOverrides": {
            "/private/tmp/foo": "gitlab.com/assured/assured-dev",
          },
        }),
      );

      // Without the override this local-path remote would normalize to null.
      expect(identityFromRemote("/private/tmp/foo")).toBe("gitlab.com/assured/assured-dev");
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

      expect(identityFromRemote("https://gitlab.com/assured/assured-dev.git")).toBe(
        "gitlab.com/assured/assured-dev",
      );
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
      const dir = await initRepo("https://gitlab.com/assured/assured-dev.git");
      try {
        expect(await deriveRepoIdentity(dir)).toBe("gitlab.com/assured/assured-dev");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a repo with no remote derives to null", async () => {
      const dir = await initRepo();
      try {
        expect(await deriveRepoIdentity(dir)).toBeNull();
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
        expect(await deriveRepoIdentity(dir)).toBe("gitlab.com/pinned/fork");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("memoizes per path: a remote change after the first call does not change the result", async () => {
      const dir = await initRepo("https://gitlab.com/assured/assured-dev.git");
      try {
        const first = await deriveRepoIdentity(dir);
        expect(first).toBe("gitlab.com/assured/assured-dev");

        await runCapture(["git", "remote", "set-url", "origin", "https://gitlab.com/other/repo.git"], {
          cwd: dir,
        });

        const second = await deriveRepoIdentity(dir);
        expect(second).toBe(first);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a failed derivation is not memoized: adding a remote after a null result is picked up on the next call, no clearIdentityMemo needed", async () => {
      const dir = await initRepo();
      try {
        expect(await deriveRepoIdentity(dir)).toBeNull();

        await runCapture(["git", "remote", "add", "origin", "https://gitlab.com/assured/assured-dev.git"], {
          cwd: dir,
        });

        expect(await deriveRepoIdentity(dir)).toBe("gitlab.com/assured/assured-dev");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("clearIdentityMemo forces re-derivation", async () => {
      const dir = await initRepo("https://gitlab.com/assured/assured-dev.git");
      try {
        const first = await deriveRepoIdentity(dir);
        expect(first).toBe("gitlab.com/assured/assured-dev");

        await runCapture(["git", "remote", "set-url", "origin", "https://gitlab.com/other/repo.git"], {
          cwd: dir,
        });
        clearIdentityMemo();

        const second = await deriveRepoIdentity(dir);
        expect(second).toBe("gitlab.com/other/repo");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
