import { test, expect } from "bun:test";
import { unknownCommandReply } from "../unknown-command.ts";

test("unknown command carries a code, version, and actionable text", () => {
  const r = unknownCommandReply("chat:archive", "v0.9.0");
  expect(r.ok).toBe(false);
  expect(r.code).toBe("unknown-command");
  expect(r.version).toBe("v0.9.0");
  expect(r.error).toContain("v0.9.0");
  expect(r.error).toContain("chat:archive");
  expect(r.error.toLowerCase()).toContain("restart");
});
