import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { hookRepoIdentity, parseHookStdin, recordClaudeHookAnswer, shouldOfferClaudeHook } from "../worktree-hook.ts";
import { loadWorktreeAppConfig } from "../../lib/worktree/config.ts";
import { getSetting } from "../../lib/settings/resolve.ts";

describe("parseHookStdin", () => {
  test("create event yields cwd and name", () => {
    const p = parseHookStdin('{"hook_event_name":"WorktreeCreate","cwd":"/r","name":"probe"}');
    expect(p).toEqual({ event: "create", cwd: "/r", name: "probe" });
  });
  test("remove event carries whichever path field is present", () => {
    expect(parseHookStdin('{"hook_event_name":"WorktreeRemove","worktree_path":"/t"}'))
      .toEqual({ event: "remove", path: "/t" });
    expect(parseHookStdin('{"hook_event_name":"WorktreeRemove","path":"/t"}'))
      .toEqual({ event: "remove", path: "/t" });
  });
  test("garbage is an error result, not a throw", () => {
    expect(parseHookStdin("not json").event).toBe("invalid");
  });
});

describe("hookRepoIdentity", () => {
  test("derivable identity not in the index: null (routes decideCreate to fallback)", () => {
    const result = hookRepoIdentity("/scratch/repo", {
      identityFor: () => "path:%2Fscratch%2Frepo",
      isRegistered: () => false,
    });
    expect(result).toBeNull();
  });

  test("identity already in the index: returned (routes decideCreate to provision)", () => {
    const result = hookRepoIdentity("/known/repo", {
      identityFor: () => "remote:example%2Fr",
      isRegistered: (identity) => identity === "remote:example%2Fr",
    });
    expect(result).toBe("remote:example%2Fr");
  });

  test("no derivable identity at all: null without consulting the index", () => {
    const result = hookRepoIdentity("/not-a-repo", {
      identityFor: () => undefined,
      isRegistered: () => { throw new Error("must not be called"); },
    });
    expect(result).toBeNull();
  });
});

describe("shouldOfferClaudeHook", () => {
  const base = { isTTY: true, json: false, batch: false, settingsFileExists: true, hookInstalled: false, priorAnswer: undefined };
  test("offers exactly in the base case", () => expect(shouldOfferClaudeHook(base)).toBe(true));
  test("never offers non-TTY, json, batch, installed, declined, or without a Claude env", () => {
    expect(shouldOfferClaudeHook({ ...base, isTTY: false })).toBe(false);
    expect(shouldOfferClaudeHook({ ...base, json: true })).toBe(false);
    expect(shouldOfferClaudeHook({ ...base, batch: true })).toBe(false);
    expect(shouldOfferClaudeHook({ ...base, hookInstalled: true })).toBe(false);
    expect(shouldOfferClaudeHook({ ...base, priorAnswer: "declined" })).toBe(false);
    expect(shouldOfferClaudeHook({ ...base, settingsFileExists: false })).toBe(false);
  });
});

describe("recordClaudeHookAnswer", () => {
  const REAL_HOME = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rt-claudehook-home-")));
  });

  afterEach(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
  });

  test("on an unowned machine, recording an answer pins the pre-existing effective config instead of flipping it", () => {
    // Unowned machine (no store rung, no legacy file): the documented S077
    // default is `enabled: false`. Regression: recordClaudeHookAnswer used to
    // write `{ claudeHook }` alone, which first-time-owned the key with no
    // `enabled` field... loadWorktreeAppConfig()'s store branch then defaults
    // `enabled` to true, silently flipping worktree-app on.
    expect(loadWorktreeAppConfig()).toEqual({ enabled: false, killProcesses: true });

    recordClaudeHookAnswer("declined");

    expect(loadWorktreeAppConfig()).toEqual({ enabled: false, killProcesses: true });
    const stored = getSetting<Record<string, unknown> | undefined>("rt.worktreeApp").value;
    expect(stored?.claudeHook).toBe("declined");
  });
});
