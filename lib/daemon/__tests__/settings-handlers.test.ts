/**
 * settings:get / settings:list — direct factory tests (RT-47 Task 6).
 *
 * Pattern mirrors endpoint-handlers.test.ts: call the handler map directly,
 * no daemon process. Every test re-points HOME to a fresh temp dir (the
 * lib/settings/resolve.test.ts pattern) since store files are process-global
 * state resolved at call time via rt-paths.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { machineSettingsPath, userSettingsPath } from "../../rt-paths.ts";
import { createSettingsHandlers } from "../handlers/settings.ts";

const IDENTITY = "gitlab.com/acme/acme-dev";

describe("settings handlers", () => {
  const origHome = process.env.HOME;
  let home: string;
  let handlers: ReturnType<typeof createSettingsHandlers>;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-settings-handlers-")));
    process.env.HOME = home;
    handlers = createSettingsHandlers();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  function write(file: string, obj: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
  }

  describe("settings:get", () => {
    test("returns value + provenance for a fixture store", async () => {
      write(userSettingsPath(), { "rt.intercepts": [{ id: "user" }] });

      const r = await handlers["settings:get"]({ key: "rt.intercepts" });

      expect(r).toMatchObject({
        ok: true,
        data: {
          value: [{ id: "user" }],
          provenance: [{ scope: "user", file: userSettingsPath() }],
        },
      });
    });

    test("machine beats user, and repoIdentity from payload reaches repo-scoped rungs", async () => {
      write(userSettingsPath(), { repos: { [IDENTITY]: { "rt.intercepts": [{ id: "user.repo" }] } } });
      write(machineSettingsPath(), { "rt.intercepts": [{ id: "machine" }] });

      const r = await handlers["settings:get"]({ key: "rt.intercepts", repoIdentity: IDENTITY });

      expect(r.ok).toBe(true);
      expect(r.data.value).toEqual([{ id: "machine" }]);
    });

    test("expand:false — a ${repoRoot} value is returned raw, never thrown, with no repo context supplied", async () => {
      write(userSettingsPath(), {
        repos: { [IDENTITY]: { "rt.roles": { backend: { hook: "${repoRoot}/dev.sh" } } } },
      });

      const r = await handlers["settings:get"]({ key: "rt.roles", repoIdentity: IDENTITY });

      expect(r.ok).toBe(true);
      expect(r.data.value.backend.hook).toBe("${repoRoot}/dev.sh");
    });

    test("missing key fails without touching the resolver", async () => {
      const r = await handlers["settings:get"]({});
      expect(r).toEqual({ ok: false, error: "missing key" });
    });

    test("an unregistered key surfaces the resolver's thrown message, not a crash", async () => {
      const r = await handlers["settings:get"]({ key: "rt.nope" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('unknown setting "rt.nope"');
    });

    test("a blank repoIdentity string coerces to no repo context (GET query-string edge case)", async () => {
      write(userSettingsPath(), { "rt.intercepts": [{ id: "global" }] });
      const r = await handlers["settings:get"]({ key: "rt.intercepts", repoIdentity: "" });
      expect(r).toMatchObject({ ok: true, data: { value: [{ id: "global" }] } });
    });
  });

  describe("settings:list", () => {
    test("labels a migrated:false key and carries its resolved value", async () => {
      write(userSettingsPath(), { "rt.hooks": { enabled: true } });

      const r = await handlers["settings:list"]({});

      expect(r.ok).toBe(true);
      const hooks = r.data.settings.find((s: any) => s.key === "rt.hooks");
      expect(hooks).toMatchObject({ migrated: false, value: { enabled: true } });
    });

    test("labels a migrated:true key as such and includes the registry default when nothing is authored", async () => {
      const r = await handlers["settings:list"]({});

      expect(r.ok).toBe(true);
      const worktrees = r.data.settings.find((s: any) => s.key === "rt.worktrees");
      expect(worktrees).toMatchObject({ migrated: true, value: { onDeck: 0 } });
    });

    test("surfaces unregistered keys found in a store", async () => {
      write(userSettingsPath(), { "rt.totallyMadeUp": 42 });

      const r = await handlers["settings:list"]({});

      const extra = r.data.settings.find((s: any) => s.key === "rt.totallyMadeUp");
      expect(extra).toMatchObject({ unregistered: true, value: 42 });
    });
  });
});
