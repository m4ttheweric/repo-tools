/**
 * lib/settings/registry.ts — the static settings schema table + lookup
 * helpers. Pure data, no file IO, so no per-test HOME faking is needed here
 * (see stores.test.ts for why other settings tests do that).
 */

import { describe, expect, test } from "bun:test";
import { allDefs, getDef, validateValue, type SettingDef } from "../registry.ts";

describe("settings/registry", () => {
  describe("getDef", () => {
    test("returns the def for a known key", () => {
      const def = getDef("rt.roles");

      expect(def).toBeDefined();
      expect(def?.key).toBe("rt.roles");
    });

    test("returns undefined for an unknown key", () => {
      expect(getDef("rt.doesNotExist")).toBeUndefined();
    });
  });

  describe("allDefs", () => {
    test("returns every registered def", () => {
      const defs = allDefs();

      expect(defs.length).toBeGreaterThan(0);
      expect(defs.map((d) => d.key)).toContain("rt.roles");
      expect(defs.map((d) => d.key)).toContain("rt.llm");
    });

    test("every def has a non-empty one-line description", () => {
      for (const def of allDefs()) {
        expect(def.description.length).toBeGreaterThan(0);
        expect(def.description).not.toContain("\n");
      }
    });

    test("every migrated:false def carries a legacyFile", () => {
      for (const def of allDefs()) {
        if (def.migrated) continue;
        expect(def.legacyFile, `${def.key} is migrated:false but has no legacyFile`).toBeTruthy();
      }
    });

    test("exactly 5 keys are migrated:true", () => {
      const migrated = allDefs().filter((d) => d.migrated);

      expect(migrated.map((d) => d.key).sort()).toEqual(
        ["rt.intercepts", "rt.repoIdentityOverrides", "rt.repoRoots", "rt.roles", "rt.worktrees"].sort(),
      );
    });

    test("every def carries scopes", () => {
      for (const def of allDefs()) {
        expect(Array.isArray(def.scopes)).toBe(true);
        expect(def.scopes.length).toBeGreaterThan(0);
      }
    });

    test("repoScoped keys allow all three scopes", () => {
      for (const def of allDefs()) {
        if (!def.repoScoped) continue;
        expect(def.scopes.sort()).toEqual(["machine", "team", "user"]);
      }
    });

    test("rt.repoIdentityOverrides is machine-only", () => {
      const def = getDef("rt.repoIdentityOverrides");

      expect(def?.scopes).toEqual(["machine"]);
    });

    test("rt.roles carries pathGuardFields: [hook]", () => {
      const def = getDef("rt.roles");

      expect(def?.pathGuardFields).toEqual(["hook"]);
    });

    test("rt.worktrees registry default is { onDeck: 0 }", () => {
      const def = getDef("rt.worktrees");

      expect(def?.default).toEqual({ onDeck: 0 });
    });

    test("rt.notifications and rt.runaway carry their sibling commands", () => {
      expect(getDef("rt.notifications")?.siblingCommand).toBe("rt settings notifications");
      expect(getDef("rt.runaway")?.siblingCommand).toBe("rt settings runaway");
    });

    test("legacyFile values match the trace for wave-1 migrated:false keys", () => {
      expect(getDef("rt.llm")?.legacyFile).toBe("llm.json");
      expect(getDef("rt.cron")?.legacyFile).toBe("cron.jsonc");
      expect(getDef("rt.repoTracking")?.legacyFile).toBe("repo-tracking.json");
      expect(getDef("rt.notifications")?.legacyFile).toBe("notifications.json");
    });

    test("repoScoped is consistent with a repos/<repo>/... legacyFile prefix, in both directions", () => {
      // Regression test for a metadata error a reviewer caught: a def whose
      // legacy reader is rooted at repoDataDir() (i.e. its legacyFile is
      // repo-scoped) must be marked repoScoped:true, and vice versa —
      // repoScoped:true must never sit on a def whose legacyFile is actually
      // a global (non-repo) path. Catches this class of drift for every
      // migrated:false def, not just the ones with a dedicated spot-check
      // below. (migrated:true defs carry no legacyFile at all — their reader
      // goes through the resolver, not a legacy file path — so they're
      // outside the scope of this check; rt.roles/rt.intercepts/rt.worktrees
      // are repoScoped for reasons unrelated to any legacyFile prefix.)
      for (const def of allDefs()) {
        if (def.migrated) continue;
        const legacyFileIsRepoScoped = def.legacyFile?.startsWith("repos/<repo>/") ?? false;
        expect(
          Boolean(def.repoScoped),
          `${def.key}: repoScoped (${Boolean(def.repoScoped)}) must match legacyFile repo-scoping (${legacyFileIsRepoScoped}, legacyFile=${def.legacyFile ?? "none"})`,
        ).toBe(legacyFileIsRepoScoped);
      }
    });

    test("the six traced repo-scoped legacy keys carry repoScoped:true and the repos/<repo>/ prefix", () => {
      const repoScopedLegacyKeys: Record<string, string> = {
        "rt.sync": "repos/<repo>/sync.json",
        "rt.branchNaming": "repos/<repo>/branch-naming.json",
        "rt.variations": "repos/<repo>/variations.json",
        "rt.presets": "repos/<repo>/presets/<name>.json",
        "rt.dopplerTemplate": "repos/<repo>/doppler-template.yaml",
        "rt.hooks": "repos/<repo>/hooks.json",
      };

      for (const [key, legacyFile] of Object.entries(repoScopedLegacyKeys)) {
        const def = getDef(key);
        expect(def?.repoScoped, `${key} should be repoScoped:true`).toBe(true);
        expect(def?.legacyFile, `${key} legacyFile`).toBe(legacyFile);
      }
    });

    test("the six genuinely global legacy keys stay repoScoped:undefined with a bare (non-repos/) legacyFile", () => {
      for (const key of ["rt.llm", "rt.cron", "rt.repoTracking", "rt.notifications", "rt.workspacePrefs", "rt.runaway"]) {
        const def = getDef(key);
        expect(def?.repoScoped, `${key} should not be repoScoped`).toBeFalsy();
        expect(def?.legacyFile?.startsWith("repos/"), `${key} legacyFile should not be repo-prefixed`).toBe(false);
      }
    });

    test("has exactly the 12 wave-1 migrated:false keys plus the 5 migrated:true keys", () => {
      const migratedFalseKeys = [
        "rt.llm",
        "rt.cron",
        "rt.repoTracking",
        "rt.notifications",
        "rt.sync",
        "rt.branchNaming",
        "rt.variations",
        "rt.presets",
        "rt.dopplerTemplate",
        "rt.workspacePrefs",
        "rt.runaway",
        "rt.hooks",
      ];
      const migratedTrueKeys = ["rt.roles", "rt.intercepts", "rt.worktrees", "rt.repoIdentityOverrides", "rt.repoRoots"];

      expect(allDefs().map((d) => d.key).sort()).toEqual([...migratedFalseKeys, ...migratedTrueKeys].sort());
    });
  });

  describe("validateValue", () => {
    const stringDef: SettingDef = {
      key: "test.string",
      type: "string",
      scopes: ["user"],
      merge: "replace",
      migrated: true,
      description: "a test string field",
    };
    const numberDef: SettingDef = { ...stringDef, key: "test.number", type: "number" };
    const booleanDef: SettingDef = { ...stringDef, key: "test.boolean", type: "boolean" };
    const objectDef: SettingDef = { ...stringDef, key: "test.object", type: "object" };
    const arrayDef: SettingDef = { ...stringDef, key: "test.array", type: "array" };

    test("string: accepts a string, rejects a number", () => {
      expect(validateValue(stringDef, "hello")).toEqual({ ok: true });
      expect(validateValue(stringDef, 5).ok).toBe(false);
    });

    test("number: accepts a number, rejects a string", () => {
      expect(validateValue(numberDef, 5)).toEqual({ ok: true });
      expect(validateValue(numberDef, "5").ok).toBe(false);
    });

    test("boolean: accepts a boolean, rejects a string", () => {
      expect(validateValue(booleanDef, true)).toEqual({ ok: true });
      expect(validateValue(booleanDef, "true").ok).toBe(false);
    });

    test("object: accepts a plain object, rejects an array and null", () => {
      expect(validateValue(objectDef, { a: 1 })).toEqual({ ok: true });
      expect(validateValue(objectDef, [1, 2]).ok).toBe(false);
      expect(validateValue(objectDef, null).ok).toBe(false);
    });

    test("array: accepts an array, rejects a plain object", () => {
      expect(validateValue(arrayDef, [1, 2])).toEqual({ ok: true });
      expect(validateValue(arrayDef, { a: 1 }).ok).toBe(false);
    });

    test("object/array mismatch reasons name the expected and actual shape", () => {
      const result = validateValue(objectDef, [1, 2]);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    });

    test("pathGuardFields: an absolute-path-looking string on a guarded field is rejected", () => {
      const rolesDef = getDef("rt.roles")!;
      const result = validateValue(rolesDef, {
        backend: { pool: [], hook: "/Users/matt/scripts/hook.ts" },
      });

      expect(result.ok).toBe(false);
    });

    test("pathGuardFields: a non-path hook value is accepted", () => {
      const rolesDef = getDef("rt.roles")!;
      const result = validateValue(rolesDef, {
        backend: { pool: [], hook: "bun ${team:acme}/scripts/hook.ts" },
      });

      expect(result.ok).toBe(true);
    });

    test("pathGuardFields: a ~-prefixed hook value is rejected", () => {
      const rolesDef = getDef("rt.roles")!;
      const result = validateValue(rolesDef, {
        backend: { pool: [], hook: "~/scripts/hook.ts" },
      });

      expect(result.ok).toBe(false);
    });
  });
});
