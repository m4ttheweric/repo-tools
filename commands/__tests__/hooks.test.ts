/**
 * commands/hooks.ts — the git-hook enable/disable machinery. `rt.hooks` is
 * the authoritative settings key (ownership latch); hooks.json is its
 * DERIVED CACHE — the installed shim still greps that file with zero
 * process spawns, so these tests cover the cache staying in sync with
 * whatever the resolver currently says, not a settings-resolver read on the
 * hot path (there isn't one).
 *
 * Every test re-points HOME to a fresh temp dir (the settings/write.test.ts
 * pattern): store files and repoDataDir() both resolve HOME at call time.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverHooks,
  generateShims,
  hooksConfigPath,
  loadHooksConfig,
  regenerateHooksCache,
  saveHooksConfig,
  toggleHooks,
  type HooksConfig,
} from "../hooks.ts";
import type { CommandContext } from "../../lib/command-tree.ts";
import { repoDataDir, userSettingsPath } from "../../lib/rt-paths.ts";
import { getSetting } from "../../lib/settings/resolve.ts";
import { setSetting } from "../../lib/settings/write.ts";

// Captured at module load — before any mock.module runs — so afterEach can
// restore the real daemon client. Top-level await is legal in an ESM test file.
const realDaemonClient = await import("../../lib/daemon-client.ts");
const realDaemonQuery = realDaemonClient.daemonQuery;

const IDENTITY = "example.com/org/repo";

describe("commands/hooks", () => {
  const origHome = process.env.HOME;
  let home: string;
  let dataDir: string;
  let repoRoot: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-hooks-test-")));
    process.env.HOME = home;
    dataDir = repoDataDir("repo");
    mkdirSync(dataDir, { recursive: true });
    repoRoot = mkdtempSync(join(tmpdir(), "rt-hooks-repo-"));
    mkdirSync(join(repoRoot, ".husky"));
    writeFileSync(join(repoRoot, ".husky", "pre-commit"), "");
    writeFileSync(join(repoRoot, ".husky", "pre-push"), "");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeLegacy(config: Partial<HooksConfig>): void {
    writeFileSync(hooksConfigPath(dataDir), JSON.stringify(config));
  }

  function readCache(): unknown {
    return JSON.parse(readFileSync(hooksConfigPath(dataDir), "utf8"));
  }

  function writeStoreValue(value: unknown): void {
    mkdirSync(join(userSettingsPath(), ".."), { recursive: true });
    writeFileSync(userSettingsPath(), JSON.stringify({ repos: { [IDENTITY]: { "rt.hooks": value } } }));
  }

  // ─── loadHooksConfig — ownership latch, store wins per field ────────────────

  describe("loadHooksConfig", () => {
    test("legacy file: unset hooks default to enabled", () => {
      writeLegacy({ enabled: true, hooks: { "pre-commit": false } });
      const cfg = loadHooksConfig(dataDir, ["pre-commit", "pre-push"], null);
      expect(cfg).toEqual({ enabled: true, hooks: { "pre-commit": false, "pre-push": true } });
    });

    test("no legacy file, no store: everything defaults enabled", () => {
      const cfg = loadHooksConfig(dataDir, ["pre-commit"], null);
      expect(cfg).toEqual({ enabled: true, hooks: { "pre-commit": true } });
    });

    test("store owns the key: per-hook-name fields default enabled when the store doesn't name them", () => {
      writeStoreValue({ enabled: true, hooks: { "pre-commit": false } });
      const cfg = loadHooksConfig(dataDir, ["pre-commit", "pre-push"], IDENTITY);
      expect(cfg).toEqual({ enabled: true, hooks: { "pre-commit": false, "pre-push": true } });
    });

    test("store owns the key even when the legacy file is still present — store wins", () => {
      writeLegacy({ enabled: true, hooks: { "pre-commit": true } });
      writeStoreValue({ enabled: false, hooks: {} });
      const cfg = loadHooksConfig(dataDir, ["pre-commit"], IDENTITY);
      expect(cfg.enabled).toBe(false);
    });
  });

  // ─── regenerateHooksCache — the derived-cache refresh ───────────────────────

  describe("regenerateHooksCache", () => {
    test("no .husky/ in the repo -> no-op, no file created", () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "rt-hooks-empty-"));
      regenerateHooksCache(emptyRepo, dataDir, null);
      expect(() => readCache()).toThrow();
      rmSync(emptyRepo, { recursive: true, force: true });
    });

    test("store owns the key: cache is rewritten to match the resolved value, even overwriting stale legacy content", () => {
      writeLegacy({ enabled: true, hooks: { "pre-commit": true, "pre-push": true } });
      writeStoreValue({ enabled: false, hooks: { "pre-commit": true } });

      regenerateHooksCache(repoRoot, dataDir, IDENTITY);

      // pre-push isn't named in the store's hooks map -> defaults enabled,
      // NOT carried over from the legacy file's stale "true" for it either.
      expect(readCache()).toEqual({ enabled: false, hooks: { "pre-commit": true, "pre-push": true } });
    });

    test("store unowned: cache is rewritten from the legacy file's own content (idempotent, fills in newly-discovered hooks)", () => {
      writeLegacy({ enabled: true, hooks: { "pre-commit": false } });

      regenerateHooksCache(repoRoot, dataDir, null);

      expect(readCache()).toEqual({ enabled: true, hooks: { "pre-commit": false, "pre-push": true } });
    });

    test("a store probe failure is best-effort — never throws, and the cache still gets written from the legacy fallback", () => {
      mkdirSync(join(userSettingsPath(), ".."), { recursive: true });
      writeFileSync(userSettingsPath(), "{not valid json");

      expect(() => regenerateHooksCache(repoRoot, dataDir, IDENTITY)).not.toThrow();
      expect(readCache()).toEqual({ enabled: true, hooks: { "pre-commit": true, "pre-push": true } });
    });
  });

  // ─── the rt.hooks settings-store write path stays in sync via regeneration ──

  describe("store writes + regeneration keep hooks.json honest", () => {
    test("a raw setSetting write (simulating the `rt settings set --repo` seam) is picked up by a subsequent regenerate", () => {
      setSetting("rt.hooks", { enabled: false, hooks: {} }, "machine", { repoIdentity: IDENTITY });

      regenerateHooksCache(repoRoot, dataDir, IDENTITY);

      expect(readCache()).toEqual({ enabled: false, hooks: { "pre-commit": true, "pre-push": true } });
      // and the store itself really does own it now
      expect(getSetting("rt.hooks", { repoIdentity: IDENTITY }).value).toEqual({ enabled: false, hooks: {} });
    });
  });

  // ─── saveHooksConfig — write routing + cache regeneration ───────────────────

  describe("saveHooksConfig", () => {
    test("no legacy file, no repoIdentity reachable -> writes the legacy file directly (store unreachable)", () => {
      const next: HooksConfig = { enabled: false, hooks: { "pre-commit": false } };
      saveHooksConfig(repoRoot, dataDir, next, null);
      expect(readCache()).toEqual(next);
      expect(getSetting("rt.hooks", { repoIdentity: IDENTITY }).value).toBeUndefined();
    });

    test("legacy file present, store unowned -> writes the legacy file, store stays untouched", () => {
      writeLegacy({ enabled: true, hooks: {} });
      const next: HooksConfig = { enabled: false, hooks: { "pre-commit": false } };

      saveHooksConfig(repoRoot, dataDir, next, IDENTITY);

      expect(readCache()).toEqual(next);
      expect(getSetting("rt.hooks", { repoIdentity: IDENTITY }).value).toBeUndefined();
    });

    test("no legacy file, repoIdentity in hand -> writes the store AND regenerates the cache file (ENOENT bootstraps straight into the store)", () => {
      const next: HooksConfig = { enabled: false, hooks: { "pre-commit": false } };

      saveHooksConfig(repoRoot, dataDir, next, IDENTITY);

      expect(getSetting("rt.hooks", { repoIdentity: IDENTITY }).value).toEqual(next);
      expect(readCache()).toEqual({ enabled: false, hooks: { "pre-commit": false, "pre-push": true } });
    });

    test("legacy file present AND store already owns the key -> the file's mere presence does not win; writes the store and refreshes the cache", () => {
      // The exact bug this routing rule exists to avoid: once regeneration
      // has run once, hooks.json always exists — so existsSync() alone can
      // no longer be the signal for "the file is still authoritative."
      writeStoreValue({ enabled: true, hooks: {} });
      regenerateHooksCache(repoRoot, dataDir, IDENTITY); // hooks.json now exists, purely as a cache
      expect(readCache()).toBeTruthy();

      const next: HooksConfig = { enabled: false, hooks: { "pre-commit": false } };
      saveHooksConfig(repoRoot, dataDir, next, IDENTITY);

      expect(getSetting("rt.hooks", { repoIdentity: IDENTITY }).value).toEqual(next);
      expect(readCache()).toEqual({ enabled: false, hooks: { "pre-commit": false, "pre-push": true } });
    });
  });

  // ─── generateShims — reverted to the zero-spawn grep, unchanged from before ─

  describe("generateShims", () => {
    test("pre-commit shim greps hooks.json, keeps the on-deck guard and husky delegation — no rt exec anywhere", () => {
      generateShims(dataDir, ["pre-commit", "pre-push"]);
      const shim = readFileSync(join(dataDir, "hooks", "pre-commit"), "utf8");

      expect(shim).toContain("HOOKS_CONFIG=");
      expect(shim).toContain("grep -o");

      // on-deck guard, unchanged
      expect(shim).toContain("on-deck/*");
      expect(shim).toContain("commits are not allowed on on-deck branches");

      // husky delegation, unchanged
      expect(shim).toContain('REAL_HOOK="$REPO_ROOT/.husky/$HOOK_NAME"');
      expect(shim).toContain('exec "$REAL_HOOK" "$@"');

      // no process spawn on the hot path
      expect(shim).not.toContain("rt hooks check");
      expect(shim).not.toContain("command -v rt");
    });

    test("a non-pre-commit hook carries no on-deck guard", () => {
      generateShims(dataDir, ["pre-push"]);
      const shim = readFileSync(join(dataDir, "hooks", "pre-push"), "utf8");
      expect(shim).not.toContain("on-deck");
    });
  });

  // ─── rt hooks status self-heals the cache ───────────────────────────────────

  describe("toggleHooks status regenerates the cache before displaying", () => {
    function ctxFor(remoteUrl: string): CommandContext {
      return { identity: { repoName: "repo", identity: "path:%2Frepo", repoRoot, dataDir, remoteUrl, baseUrl: "" } };
    }

    test("stale cache + store-owned value -> status leaves hooks.json matching the resolved store value", async () => {
      writeLegacy({ enabled: true, hooks: { "pre-commit": true, "pre-push": true } }); // stale, pre-store
      writeStoreValue({ enabled: false, hooks: { "pre-commit": true } });

      await toggleHooks(["status"], ctxFor("git@example.com:org/repo.git"));

      expect(readCache()).toEqual({ enabled: false, hooks: { "pre-commit": true, "pre-push": true } });
    });

    test("the non-TTY no-subcommand fallback also self-heals", async () => {
      writeLegacy({ enabled: true, hooks: {} });
      writeStoreValue({ enabled: false, hooks: {} });

      await toggleHooks([], ctxFor("git@example.com:org/repo.git")); // process.stdin.isTTY is false under the test runner

      expect(readCache()).toEqual({ enabled: false, hooks: { "pre-commit": true, "pre-push": true } });
    });

    test("a regen failure during status does not throw, break the display, or change what's on disk", async () => {
      writeStoreValue({ enabled: true, hooks: {} });
      writeLegacy({ enabled: true, hooks: { "pre-commit": true, "pre-push": true } });
      // Strip write permission on the FILE (not just the dir — an existing
      // file's content can be overwritten without directory write access)
      // so the cache write inside regenerateHooksCache fails with EACCES.
      chmodSync(hooksConfigPath(dataDir), 0o400);
      try {
        await expect(toggleHooks(["status"], ctxFor("git@example.com:org/repo.git"))).resolves.toBeUndefined();
      } finally {
        chmodSync(hooksConfigPath(dataDir), 0o600);
      }
      // the pre-existing (now stale) file is untouched — the failed write never landed
      expect(readCache()).toEqual({ enabled: true, hooks: { "pre-commit": true, "pre-push": true } });
    });
  });

  // ─── discoverHooks — unchanged behavior, sanity check ───────────────────────

  test("discoverHooks lists files under .husky, skipping _ and dotfiles", () => {
    writeFileSync(join(repoRoot, ".husky", ".gitignore"), "");
    mkdirSync(join(repoRoot, ".husky", "_"));
    expect(discoverHooks(repoRoot)).toEqual(["pre-commit", "pre-push"]);
  });

  // ─── the hooks:watch daemon nudge sends the SERIALIZED identity ────────────

  describe("toggleHooks daemon nudge", () => {
    afterEach(() => {
      mock.module("../../lib/daemon-client.ts", () => ({
        ...realDaemonClient,
        daemonQuery: realDaemonQuery,
      }));
    });

    test("hooks:watch is sent ctx.identity.identity, not the display repoName", async () => {
      const calls: { cmd: string; payload?: Record<string, unknown> }[] = [];
      mock.module("../../lib/daemon-client.ts", () => ({
        ...realDaemonClient,
        daemonQuery: async (cmd: string, payload?: Record<string, unknown>) => {
          calls.push({ cmd, payload });
          return { ok: true, data: null };
        },
      }));

      const ctx: CommandContext = {
        identity: { repoName: "repo", identity: "path:%2Frepo", repoRoot, dataDir, remoteUrl: "git@example.com:org/repo.git", baseUrl: "" },
      };

      await toggleHooks(["status"], ctx);
      // The nudge is fire-and-forget (`.then().catch()`, not awaited) —
      // let its microtask land before inspecting captured calls.
      await new Promise((r) => setTimeout(r, 0));

      const call = calls.find((c) => c.cmd === "hooks:watch");
      expect(call).toBeDefined();
      expect(call!.payload!.repo).toBe("path:%2Frepo");
      expect(call!.payload!.repo).not.toBe("repo");
    });
  });
});
