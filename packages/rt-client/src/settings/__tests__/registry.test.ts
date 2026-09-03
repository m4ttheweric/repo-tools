/**
 * lib/settings/registry.ts — the static settings schema table + lookup
 * helpers. Pure data, no file IO, so no per-test HOME faking is needed here
 * (see stores.test.ts for why other settings tests do that).
 */

import { describe, expect, test } from "bun:test";
import { allDefs, getDef, isMigrated, validateValue, type SettingDef } from "../registry-machinery.ts";

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
      expect(defs.map((d) => d.key)).toContain("rt.hooks");
    });

    test("every def has a non-empty one-line description", () => {
      for (const def of allDefs()) {
        expect(def.description.length).toBeGreaterThan(0);
        expect(def.description).not.toContain("\n");
      }
    });

    test("every migrated:false def carries a legacyFile", () => {
      for (const def of allDefs()) {
        if (isMigrated(def)) continue;
        expect(def.legacyFile, `${def.key} is migrated:false but has no legacyFile`).toBeTruthy();
      }
    });

    test("every migrated:true (or suite, migrated-absent) def carries no legacyFile", () => {
      for (const def of allDefs()) {
        if (!isMigrated(def)) continue;
        expect(def.legacyFile, `${def.key} is migrated but still carries a legacyFile`).toBeUndefined();
      }
    });

    test("exactly 25 keys are migrated:true", () => {
      const migrated = allDefs().filter((d) => d.migrated);

      expect(migrated.map((d) => d.key).sort()).toEqual(
        [
          "rt.intercepts", "rt.repoIdentityOverrides", "rt.repoRoots", "rt.roles", "rt.worktrees", "rt.worktreeReadyApproval",
          "rt.notifications", "rt.cron", "rt.repoTracking", "rt.runsPruneDays", "rt.runaway", "rt.workspacePrefs",
          "rt.sync", "rt.branchNaming", "rt.variations", "rt.presets", "rt.dopplerTemplate",
          "rt.homeSnapshot", "rt.worktreeApp", "rt.sdmEnrichment", "rt.logRetentionDays", "rt.logLevel", "rt.integrations", "rt.hooks",
          "rt.apiPort",
        ].sort(),
      );
    });

    test("rt.logRetentionDays is a machine+user number, default 14 (a fresh key, not a latch port)", () => {
      const def = getDef("rt.logRetentionDays");

      expect(def?.scopes.sort()).toEqual(["machine", "user"]);
      expect(def?.type).toBe("number");
      expect(def?.merge).toBe("replace");
      expect(def?.default).toBe(14);
    });

    test("chat.viewerUrl defaults to the deck-served viewer, so a fresh install's chat links work without a user setting", () => {
      const def = getDef("chat.viewerUrl");

      expect(def?.scopes).toEqual(["user"]);
      expect(def?.default).toBe("https://chat.mattstack");
    });

    test("rt.daemonPath is a machine-scoped string key with no default", () => {
      const def = getDef("rt.daemonPath");
      expect(def).toBeDefined();
      expect(def!.type).toBe("string");
      expect(def!.scopes).toEqual(["machine"]);
      expect(def!.default).toBeUndefined();
      expect(def!.pathGuardFields).toBeUndefined();
    });

    test("rt.worktreeApp is a machine-only field-bag object with no default (ownership latch)", () => {
      const def = getDef("rt.worktreeApp");

      expect(def?.scopes).toEqual(["machine"]);
      expect(def?.type).toBe("object");
      expect(def?.merge).toBe("deep");
      expect(def?.default).toBeUndefined();
    });

    test("rt.sdmEnrichment is a TEAM-ONLY map with no default (ownership latch, employer-resource invariant)", () => {
      const def = getDef("rt.sdmEnrichment");

      expect(def?.scopes).toEqual(["team"]);
      expect(def?.type).toBe("object");
      expect(def?.merge).toBe("replace");
      expect(def?.default).toBeUndefined();
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

    test("rt.homeSnapshot is a machine-only object with its documented default", () => {
      const def = getDef("rt.homeSnapshot");

      expect(def?.scopes).toEqual(["machine"]);
      expect(def?.type).toBe("object");
      expect(def?.merge).toBe("deep");
      expect(def?.default).toEqual({
        enabled: true,
        debounceSec: 20,
        pushDelaySec: 60,
        janitorThresholdHours: 6,
        janitorIntervalMin: 30,
      });
    });

    test("the six migrated global singletons carry no legacyFile", () => {
      for (const key of [
        "rt.notifications",
        "rt.cron",
        "rt.repoTracking",
        "rt.runaway",
        "rt.workspacePrefs",
        "rt.homeSnapshot",
      ]) {
        const def = getDef(key);
        expect(def?.legacyFile, `${key} should carry no legacyFile`).toBeUndefined();
      }
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
        if (isMigrated(def)) continue;
        const legacyFileIsRepoScoped = def.legacyFile?.startsWith("repos/<repo>/") ?? false;
        expect(
          Boolean(def.repoScoped),
          `${def.key}: repoScoped (${Boolean(def.repoScoped)}) must match legacyFile repo-scoping (${legacyFileIsRepoScoped}, legacyFile=${def.legacyFile ?? "none"})`,
        ).toBe(legacyFileIsRepoScoped);
      }
    });

    test("rt.hooks is a repo-scoped field-bag object with no default (ownership latch, per-hook-name fields too)", () => {
      const def = getDef("rt.hooks");
      expect(def?.repoScoped, "rt.hooks should be repoScoped:true").toBe(true);
      expect(def?.scopes.sort()).toEqual(["machine", "team", "user"]);
      expect(def?.type).toBe("object");
      expect(def?.merge).toBe("deep");
      expect(def?.default).toBeUndefined();
      expect(def?.legacyFile).toBeUndefined();
    });

    test("the five newly migrated repo-scoped keys carry repoScoped:true and no legacyFile", () => {
      for (const key of ["rt.sync", "rt.branchNaming", "rt.variations", "rt.presets", "rt.dopplerTemplate"]) {
        const def = getDef(key);
        expect(def?.repoScoped, `${key} should be repoScoped:true`).toBe(true);
        expect(def?.legacyFile, `${key} should carry no legacyFile`).toBeUndefined();
      }
    });

    test("rt.dopplerTemplate is an array key with replace merge (YAML list -> JSON array)", () => {
      const def = getDef("rt.dopplerTemplate");
      expect(def?.type).toBe("array");
      expect(def?.merge).toBe("replace");
    });

    test("has exactly the 25 migrated:true keys and the 43 suite keys", () => {
      const migratedFalseKeys: string[] = [];
      const migratedTrueKeys = [
        "rt.roles", "rt.intercepts", "rt.worktrees", "rt.worktreeReadyApproval", "rt.repoIdentityOverrides", "rt.repoRoots",
        "rt.notifications", "rt.cron", "rt.repoTracking", "rt.runsPruneDays", "rt.runaway", "rt.workspacePrefs",
        "rt.sync", "rt.branchNaming", "rt.variations", "rt.presets", "rt.dopplerTemplate",
        "rt.homeSnapshot", "rt.worktreeApp", "rt.sdmEnrichment", "rt.logRetentionDays", "rt.logLevel", "rt.integrations", "rt.hooks",
        "rt.apiPort",
      ];
      const suiteKeys = [
        "mattstack.integrations",
        "mattstack.tracking",
        "mattstack.appPath",
        "mattstack.mode",
        "mattstack.roster",
        "claude.marketplaces",
        "claude.plugins",
        "deck.apps",
        "deck.access",
        "deck.platform",
        "board.gitlabHost",
        "board.projects",
        "board.members",
        "board.title",
        "board.botUsernames",
        "board.ticketPrefixes",
        "board.slack",
        "board.doctorSkill",
        "board.triage.doctorSkill",
        "board.tabs",
        "board.staleAfterDays",
        "board.workspaces",
        "board.defaultMember",
        "board.hiddenMembers",
        "board.triage",
        "board.claudeCommand",
        "board.cwds",
        "board.triageMaxConcurrent",
        "board.switchboardUrl",
        "boxscore.projects",
        "boxscore.linearDoneStates",
        "boxscore.sizeBand",
        "boxscore.excludeFilePatterns",
        "boxscore.ignoredMrs",
        "boxscore.botPatterns",
        "boxscore.hiddenMembers",
        "boxscore.defaultRange",
        "gitq.workSlots",
        "gitq.forges",
        "gitq.board",
        "chat.handle",
        "chat.humanHandle",
        "chat.viewerUrl",
        "chat.herdrWorkspace",
        "chat.push.provider",
        "chat.push.target",
        "agent.model",
        "agent.effort",
        "agent.account",
        "agent.extraArgs",
        "rt.trustedBrowserOrigins",
        "rt.daemonPath",
        "rt.notify.eventBridges",
      ];
      expect(suiteKeys).toHaveLength(53);

      expect(allDefs().map((d) => d.key).sort()).toEqual(
        [...migratedFalseKeys, ...migratedTrueKeys, ...suiteKeys].sort(),
      );
    });

    test("every suite key (no legacyFile, no explicit migrated flag) resolves as migrated via isMigrated", () => {
      for (const def of allDefs()) {
        if (def.legacyFile !== undefined) continue; // wave-1 keys, covered above
        if (def.key.startsWith("rt.")) continue; // wave-1 migrated:true rows carry migrated:true explicitly
        expect(def.migrated, `${def.key} should omit migrated`).toBeUndefined();
        expect(isMigrated(def), `${def.key} should resolve as migrated`).toBe(true);
      }
    });

    test("board.doctorSkill and board.triage.doctorSkill are distinct rows with distinct resolution semantics documented", () => {
      const doctorSkill = getDef("board.doctorSkill");
      const triageDoctorSkill = getDef("board.triage.doctorSkill");

      expect(doctorSkill).toBeDefined();
      expect(triageDoctorSkill).toBeDefined();
      expect(doctorSkill?.key).not.toBe(triageDoctorSkill?.key);
      expect(doctorSkill?.description).toContain("skills.jsonc");
      expect(triageDoctorSkill?.description).toContain("never resolved");
    });

    test("board.triage and board.triage.doctorSkill document that they are siblings, not container/field", () => {
      // Non-obvious invariant: both are independent flat keys at different
      // scopes (user vs team) — a board reader assembles triage config from
      // them separately, board.triage does not nest doctorSkill inside it.
      const triage = getDef("board.triage");
      const triageDoctorSkill = getDef("board.triage.doctorSkill");

      expect(triage?.description).toContain("sibling");
      expect(triageDoctorSkill?.description).toContain("sibling");
    });

    test("board.hiddenMembers is a user-scope overlay, distinct from the team-scope board.members roster", () => {
      const hiddenMembers = getDef("board.hiddenMembers");
      const members = getDef("board.members");

      expect(hiddenMembers?.scopes).toEqual(["user"]);
      expect(hiddenMembers?.type).toBe("array");
      expect(hiddenMembers?.merge).toBe("replace");
      expect(hiddenMembers?.description).toContain("board.members");
      // The ruling this pins: board.members stays team-only array/replace —
      // widening it to user scope would let a personal store shadow the
      // whole team roster instead of just hiding entries from it.
      expect(members?.scopes).toEqual(["team"]);
    });

    test("scope spot-checks: deck.access is user-only, board.gitlabHost is team-only, gitq.forges is user-only, mattstack.appPath is machine-only", () => {
      expect(getDef("deck.access")?.scopes).toEqual(["user"]);
      expect(getDef("board.gitlabHost")?.scopes).toEqual(["team"]);
      expect(getDef("gitq.forges")?.scopes).toEqual(["user"]);
      expect(getDef("mattstack.appPath")?.scopes).toEqual(["machine"]);
    });

    test("claude.marketplaces and claude.plugins are user+team arrays with replace merge", () => {
      for (const key of ["claude.marketplaces", "claude.plugins"]) {
        const def = getDef(key)!;
        expect(def.scopes.sort()).toEqual(["team", "user"]);
        expect(def.type).toBe("array");
        expect(def.merge).toBe("replace");
      }
    });

    test("none of the new suite keys carry repoScoped", () => {
      for (const def of allDefs()) {
        if (def.key.startsWith("rt.")) continue; // wave-1 rows, covered above
        expect(def.repoScoped, `${def.key} should not be repoScoped`).toBeFalsy();
      }
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
