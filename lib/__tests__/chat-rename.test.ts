import { expect, test } from "bun:test";
import { planSessionRename } from "../chat-rename.ts";

const inside = { CLAUDE_CODE_SESSION_ID: "s1" };

test("renames through the herdr pane when inside one", () => {
  expect(planSessionRename({ handle: "fred", sessionId: "s1", env: { ...inside, HERDR_PANE_ID: "w1:p2" }, disabled: false })).toEqual({
    via: "herdr",
    argv: ["herdr", "pane", "run", "w1:p2", "/rename fred"],
  });
});

test("renames through claude -p --resume outside herdr", () => {
  expect(planSessionRename({ handle: "fred", sessionId: "s1", env: inside, disabled: false })).toEqual({
    via: "claude",
    argv: ["claude", "-p", "--resume", "s1", "/rename fred"],
  });
});

test("never renames a session other than the one this process runs inside", () => {
  expect(planSessionRename({ handle: "fred", sessionId: "s1", env: { CLAUDE_CODE_SESSION_ID: "other", HERDR_PANE_ID: "w1:p2" }, disabled: false })).toBeNull();
  expect(planSessionRename({ handle: "fred", sessionId: "s1", env: { HERDR_PANE_ID: "w1:p2" }, disabled: false })).toBeNull();
});

test("--no-rename wins over everything", () => {
  expect(planSessionRename({ handle: "fred", sessionId: "s1", env: { ...inside, HERDR_PANE_ID: "w1:p2" }, disabled: true })).toBeNull();
});
