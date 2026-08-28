import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { composeSessionTitle, readSessionCustomTitle } from "../chat-title.ts";

describe("composeSessionTitle", () => {
  test("no custom title: the handle alone", () => {
    expect(composeSessionTitle({ customTitle: null, prior: null, handle: "kai" })).toBe("kai");
  });

  test("a title rt typed last time is not the user's: the handle alone", () => {
    expect(composeSessionTitle({ customTitle: "kat", prior: { handle: "kat" }, handle: "kat" })).toBe("kat");
    expect(composeSessionTitle({ customTitle: "kat", prior: { handle: "kat" }, handle: "kat" })).toBe("kat");
  });

  test("a bare pool name left behind by a signed-out session is not the user's either", () => {
    expect(composeSessionTitle({ customTitle: "kat", prior: null, handle: "ada" })).toBe("ada");
    expect(composeSessionTitle({ customTitle: "kat-2", prior: null, handle: "ada" })).toBe("ada");
  });

  test("the user's title is kept and the handle appended", () => {
    expect(composeSessionTitle({ customTitle: "board review", prior: null, handle: "kai" })).toBe("board review · kai");
  });

  test("a composite rt wrote before is re-composed onto the new handle, never stacked", () => {
    expect(composeSessionTitle({ customTitle: "board review · kat", prior: { handle: "kat" }, handle: "kai" })).toBe("board review · kai");
    expect(composeSessionTitle({ customTitle: "board review · kat", prior: null, handle: "kai" })).toBe("board review · kai");
    expect(composeSessionTitle({ customTitle: "board review · mr-board", prior: { handle: "mr-board" }, handle: "mr-board" })).toBe("board review · mr-board");
  });

  test("a user title that already is the handle stays a single name", () => {
    expect(composeSessionTitle({ customTitle: "kai", prior: null, handle: "kai" })).toBe("kai");
  });
});

describe("readSessionCustomTitle", () => {
  function configDirWith(sessionId: string, lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "rt-chat-title-"));
    const project = join(dir, "projects", "-Users-me-repo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${sessionId}.jsonl`), lines.join("\n") + "\n");
    return dir;
  }

  test("returns the last custom-title entry of the session's transcript", () => {
    const dir = configDirWith("s1", [
      JSON.stringify({ type: "user", message: "hi" }),
      JSON.stringify({ type: "custom-title", customTitle: "first", sessionId: "s1" }),
      JSON.stringify({ type: "custom-title", customTitle: "board review", sessionId: "s1" }),
    ]);
    expect(readSessionCustomTitle("s1", dir)).toBe("board review");
  });

  test("null when the transcript has no custom title, or no transcript exists", () => {
    const dir = configDirWith("s1", [JSON.stringify({ type: "user", message: "hi" })]);
    expect(readSessionCustomTitle("s1", dir)).toBeNull();
    expect(readSessionCustomTitle("s2", dir)).toBeNull();
    expect(readSessionCustomTitle("s1", join(dir, "missing"))).toBeNull();
  });

  test("never reads outside the config dir for a hostile session id", () => {
    const dir = configDirWith("s1", []);
    expect(readSessionCustomTitle("../../etc/passwd", dir)).toBeNull();
  });
});
