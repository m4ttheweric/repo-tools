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

    test("exactly 4 keys are migrated:true", () => {
      const migrated = allDefs().filter((d) => d.migrated);

      expect(migrated.map((d) => d.key).sort()).toEqual(
        ["rt.intercepts", "rt.repoIdentityOverrides", "rt.roles", "rt.worktrees"].sort(),
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
      expect(getDef("rt.mr")?.legacyFile).toBe("repos/<repo>/mr.json");
    });

    test("has exactly the 14 wave-1 migrated:false keys plus the 4 migrated:true keys", () => {
      const migratedFalseKeys = [
        "rt.llm",
        "rt.cron",
        "rt.repoTracking",
        "rt.notifications",
        "rt.mr",
        "rt.sync",
        "rt.branchNaming",
        "rt.variations",
        "rt.presets",
        "rt.workspaceSync",
        "rt.dopplerTemplate",
        "rt.workspacePrefs",
        "rt.runaway",
        "rt.hooks",
      ];
      const migratedTrueKeys = ["rt.roles", "rt.intercepts", "rt.worktrees", "rt.repoIdentityOverrides"];

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
        backend: { pool: [], hook: "bun ${team:claimview}/scripts/hook.ts" },
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
