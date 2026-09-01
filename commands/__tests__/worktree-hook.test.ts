import { describe, expect, test } from "bun:test";
import { parseHookStdin } from "../worktree-hook.ts";

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
