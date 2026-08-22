import { describe, expect, test } from "bun:test";
import { installCronTrigger, triageTrigger, type CronTrigger, type InstallCronTriggerDeps } from "../cron-install.ts";

const REAL_DEF = { key: "rt.cron", type: "object" as const, scopes: ["machine" as const], merge: "deep" as const, migrated: true, description: "" };

function fakeDeps(overrides: Partial<InstallCronTriggerDeps> = {}): InstallCronTriggerDeps & { setSettingCalls: [string, unknown, string][] } {
  const setSettingCalls: [string, unknown, string][] = [];
  return {
    getDef: (() => REAL_DEF) as InstallCronTriggerDeps["getDef"],
    isMigrated: (() => true) as InstallCronTriggerDeps["isMigrated"],
    getSetting: (() => ({ value: { triggers: [] }, provenance: [] })) as InstallCronTriggerDeps["getSetting"],
    setSetting: ((key: string, value: unknown, scope: string) => {
      setSettingCalls.push([key, value, scope]);
    }) as InstallCronTriggerDeps["setSetting"],
    setSettingCalls,
    ...overrides,
  };
}

describe("triageTrigger", () => {
  test("builds the board-triage trigger shape", () => {
    expect(triageTrigger("/path/to/board")).toEqual({
      name: "board-triage",
      event: "project-mrs",
      run: ["/path/to/board", "triage", "--once"],
      debounceMs: 5000,
    });
  });
});

describe("installCronTrigger", () => {
  test("written:false, with a reason, when rt.cron is not migrated", () => {
    const deps = fakeDeps({ isMigrated: () => false });
    const result = installCronTrigger(triageTrigger("/path/to/board"), deps);
    expect(result).toEqual({ written: false, reason: "rt.cron is not migrated to the settings stores yet (settings lane in flight)" });
  });

  test("written:false when the def itself is unknown", () => {
    const deps = fakeDeps({ getDef: (() => undefined) as InstallCronTriggerDeps["getDef"] });
    const result = installCronTrigger(triageTrigger("/path/to/board"), deps);
    expect(result.written).toBe(false);
  });

  test("writes {triggers} via setSetting with machine scope when migrated", () => {
    const deps = fakeDeps();
    const trigger = triageTrigger("/path/to/board");

    const result = installCronTrigger(trigger, deps);

    expect(result).toEqual({ written: true });
    expect(deps.setSettingCalls).toEqual([["rt.cron", { triggers: [trigger] }, "machine"]]);
  });

  test("replaces an existing trigger of the same name instead of duplicating it", () => {
    const stale: CronTrigger = { name: "board-triage", event: "project-mrs", run: ["/old/board", "triage", "--once"], debounceMs: 5000 };
    const other: CronTrigger = { name: "other-trigger", event: "x", run: ["y"] };
    const deps = fakeDeps({
      getSetting: (() => ({ value: { triggers: [stale, other] }, provenance: [] })) as InstallCronTriggerDeps["getSetting"],
    });
    const trigger = triageTrigger("/new/board");

    installCronTrigger(trigger, deps);

    expect(deps.setSettingCalls).toEqual([["rt.cron", { triggers: [other, trigger] }, "machine"]]);
  });
});
