import { describe, expect, test } from "bun:test";
import { parseHookStdin, shouldOfferClaudeHook } from "../worktree-hook.ts";

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
