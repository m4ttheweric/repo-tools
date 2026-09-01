import { describe, expect, test } from "bun:test";
import {
  installCronTrigger,
  removeCronTrigger,
  resolveBoardTriage,
  triageTrigger,
  type CronTrigger,
  type InstallCronTriggerDeps,
} from "../cron-install.ts";

function fakeDeps(overrides: Partial<InstallCronTriggerDeps> = {}): InstallCronTriggerDeps & { setSettingCalls: [string, unknown, string][] } {
  const setSettingCalls: [string, unknown, string][] = [];
  return {
    getSetting: (() => ({ value: { triggers: [] }, provenance: [] })) as InstallCronTriggerDeps["getSetting"],
    setSetting: ((key: string, value: unknown, scope: string) => {
      setSettingCalls.push([key, value, scope]);
    }) as InstallCronTriggerDeps["setSetting"],
    setSettingCalls,
    ...overrides,
  };
}

describe("triageTrigger", () => {
  test("builds the board-triage trigger shape around the given run argv", () => {
    expect(triageTrigger(["bun", "run", "/checkout/board/bin/triage.ts"])).toEqual({
      name: "board-triage",
      event: "project-mrs",
      run: ["bun", "run", "/checkout/board/bin/triage.ts"],
      debounceMs: 5000,
    });
  });
});

describe("resolveBoardTriage", () => {
  const boardRepo = { repoName: "board", worktrees: [{ path: "/repos/board", branch: "main", isBare: false }] };

  test("checkout: a registered board repo carrying bin/triage.ts wires bun run against it", () => {
    const p = { exists: (path: string) => path === "/repos/board/bin/triage.ts" };
    const result = resolveBoardTriage(p, [boardRepo], ["/opt/board"]);
    expect(result).toEqual({ kind: "checkout", run: ["bun", "run", "/repos/board/bin/triage.ts"] });
  });

  test("two repos both labelled board: no arbitrary pick, fall back to bundled", () => {
    const a = { repoName: "remote:github.com%2Fm4ttstack%2Fboard", worktrees: [{ path: "/repos/board-a", branch: "main", isBare: false }] };
    const b = { repoName: "remote:github.com%2Fsomeone%2Fboard", worktrees: [{ path: "/repos/board-b", branch: "main", isBare: false }] };
    const p = { exists: () => true };

    expect(resolveBoardTriage(p, [a, b], ["/opt/board"])).toEqual({ kind: "bundled", run: ["/opt/board", "triage"] });
  });

  test("checkout wins even when a bundled board also resolves", () => {
    const p = { exists: () => true };
    const result = resolveBoardTriage(p, [boardRepo], ["/opt/board"]);
    expect(result.kind).toBe("checkout");
  });

  test("a board repo without bin/triage.ts falls back to the bundled binary's triage subcommand", () => {
    const p = { exists: () => false };
    const result = resolveBoardTriage(p, [boardRepo], ["/opt/board"]);
    expect(result).toEqual({ kind: "bundled", run: ["/opt/board", "triage"] });
  });

  test("an unregistered (scanned) board candidate is not trusted as a checkout, falls back to bundled", () => {
    const p = { exists: () => true };
    const scanned = { ...boardRepo, registered: false };
    const result = resolveBoardTriage(p, [scanned], ["/opt/board"]);
    expect(result).toEqual({ kind: "bundled", run: ["/opt/board", "triage"] });
  });

  test("no checkout, no resolvable board at all: missing", () => {
    const p = { exists: () => false };
    const result = resolveBoardTriage(p, [], null);
    expect(result).toEqual({ kind: "missing" });
  });

  test("no checkout, but a bundled board resolves: wires its triage subcommand", () => {
    const p = { exists: () => false };
    const result = resolveBoardTriage(p, [], ["/opt/board"]);
    expect(result).toEqual({ kind: "bundled", run: ["/opt/board", "triage"] });
  });
});

describe("installCronTrigger", () => {
  test("writes {triggers} via setSetting with machine scope", () => {
    const deps = fakeDeps();
    const trigger = triageTrigger(["bun", "run", "/checkout/board/bin/triage.ts"]);

    const result = installCronTrigger(trigger, deps);

    expect(result).toEqual({ written: true });
    expect(deps.setSettingCalls).toEqual([["rt.cron", { triggers: [trigger] }, "machine"]]);
  });

  test("replaces an existing trigger of the same name instead of duplicating it", () => {
    const stale: CronTrigger = { name: "board-triage", event: "project-mrs", run: ["bun", "run", "/old/board/bin/triage.ts"], debounceMs: 5000 };
    const other: CronTrigger = { name: "other-trigger", event: "x", run: ["y"] };
    const deps = fakeDeps({
      getSetting: (() => ({ value: { triggers: [stale, other] }, provenance: [] })) as InstallCronTriggerDeps["getSetting"],
    });
    const trigger = triageTrigger(["bun", "run", "/new/board/bin/triage.ts"]);

    installCronTrigger(trigger, deps);

    expect(deps.setSettingCalls).toEqual([["rt.cron", { triggers: [other, trigger] }, "machine"]]);
  });
});

describe("removeCronTrigger", () => {
  test("drops the named trigger and leaves the rest", () => {
    const target: CronTrigger = { name: "board-triage", event: "project-mrs", run: ["bun", "run", "/x/bin/triage.ts"], debounceMs: 5000 };
    const other: CronTrigger = { name: "other-trigger", event: "x", run: ["y"] };
    const deps = fakeDeps({
      getSetting: (() => ({ value: { triggers: [target, other] }, provenance: [] })) as InstallCronTriggerDeps["getSetting"],
    });

    const result = removeCronTrigger("board-triage", deps);

    expect(result).toEqual({ written: true, removed: true });
    expect(deps.setSettingCalls).toEqual([["rt.cron", { triggers: [other] }, "machine"]]);
  });

  test("removing a trigger that was never installed is a coherent no-op", () => {
    const other: CronTrigger = { name: "other-trigger", event: "x", run: ["y"] };
    const deps = fakeDeps({
      getSetting: (() => ({ value: { triggers: [other] }, provenance: [] })) as InstallCronTriggerDeps["getSetting"],
    });

    const result = removeCronTrigger("board-triage", deps);

    expect(result).toEqual({ written: true, removed: false });
    expect(deps.setSettingCalls).toEqual([["rt.cron", { triggers: [other] }, "machine"]]);
  });
});
