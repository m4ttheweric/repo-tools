/**
 * lib/chat-session.ts — the session file behind chat presence resolution.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  currentSessionId,
  deleteChatSession,
  isValidSessionId,
  readChatSession,
  sessionFilePath,
  writeChatSession,
  type ChatSession,
} from "../chat-session.ts";

describe("chat-session", () => {
  let home = "";
  let origHome: string | undefined;
  let origSessionId: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    origSessionId = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    home = mkdtempSync(join(tmpdir(), "rt-chat-session-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = origSessionId;
    rmSync(home, { recursive: true, force: true });
  });

  test("sessionFilePath resolves under the rt home at call-time HOME", () => {
    expect(sessionFilePath("s1")).toBe(join(home, ".mattstack", "rt", "chat", "sessions", "s1.json"));
  });

  test("writeChatSession then readChatSession round-trips", () => {
    const session: ChatSession = {
      sessionId: "s1",
      handle: "x-2",
      baseHandle: "x",
      signedInAt: 1000,
      room: "acme-dev",
    };
    writeChatSession(session);
    expect(readChatSession("s1")).toEqual(session);
  });

  test("readChatSession returns null when no file exists", () => {
    expect(readChatSession("nope")).toBeNull();
  });

  test("readChatSession returns null for an undefined session id", () => {
    expect(readChatSession(undefined)).toBeNull();
  });

  test("readChatSession returns null on a session-id mismatch (a copied ~/.mattstack, a resumed session)", () => {
    // A file AT s1's path whose own sessionId names a different session —
    // the shape a copied ~/.mattstack or a resumed-under-a-new-id session
    // leaves behind. Written directly, not via writeChatSession, since that
    // helper always derives the path from its own argument's sessionId.
    const path = sessionFilePath("s1");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sessionId: "stale-id", handle: "x", baseHandle: "x", signedInAt: 1000 }));
    expect(readChatSession("s1")).toBeNull();
  });

  test("readChatSession returns null when the file's handle field isn't a string (never coerces undefined into the pidfile-path segment \"undefined\")", () => {
    const path = sessionFilePath("s1");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ sessionId: "s1", baseHandle: "x", signedInAt: 1000 })); // handle omitted entirely
    expect(readChatSession("s1")).toBeNull();
  });

  test("sessionFilePath rejects an id with path-traversal characters", () => {
    expect(() => sessionFilePath("../../etc/passwd")).toThrow(/invalid session id/);
    expect(() => sessionFilePath("a/b")).toThrow(/invalid session id/);
  });

  test("isValidSessionId accepts the charset sessionFilePath allows and rejects everything else", () => {
    expect(isValidSessionId("abc123_.-")).toBe(true);
    expect(isValidSessionId("../x")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
  });

  test("readChatSession degrades a path-traversal id to null rather than throwing (every read-only verb runs this on unvalidated input)", () => {
    expect(readChatSession("../../etc/passwd")).toBeNull();
  });

  test("deleteChatSession removes the file", () => {
    writeChatSession({ sessionId: "s1", handle: "x", baseHandle: "x", signedInAt: 1000 });
    expect(existsSync(sessionFilePath("s1"))).toBe(true);
    deleteChatSession("s1");
    expect(existsSync(sessionFilePath("s1"))).toBe(false);
  });

  test("deleteChatSession is a no-op when the file is already gone", () => {
    expect(() => deleteChatSession("never-existed")).not.toThrow();
  });

  test("currentSessionId prefers --session over the environment variable", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "env-id";
    expect(currentSessionId(["post", "r", "hi", "--session", "flag-id"])).toBe("flag-id");
  });

  test("currentSessionId falls back to CLAUDE_CODE_SESSION_ID when --session is absent", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "env-id";
    expect(currentSessionId(["post", "r", "hi"])).toBe("env-id");
  });

  test("currentSessionId is undefined with neither source", () => {
    expect(currentSessionId(["post", "r", "hi"])).toBeUndefined();
  });

  test("currentSessionId treats --session immediately followed by another flag as missing, not that flag's name", () => {
    expect(currentSessionId(["sign-in", "--session", "--no-room"])).toBeUndefined();
  });

  test("currentSessionId falls back to the environment variable when --session's value looks like a flag", () => {
    process.env.CLAUDE_CODE_SESSION_ID = "env-id";
    expect(currentSessionId(["sign-in", "--session", "--no-room"])).toBe("env-id");
  });
});
