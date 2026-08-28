import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveInbox } from "../claude-registry.ts";

function fakeRoot(entries: Array<{ pid: number; sessionId: string; sock?: string; status?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "creg-"));
  for (const e of entries) {
    writeFileSync(
      join(root, `${e.pid}.json`),
      JSON.stringify({ pid: e.pid, sessionId: e.sessionId, messagingSocketPath: e.sock ?? `/tmp/cc-socks/${e.pid}.sock`, status: e.status ?? "idle" }),
    );
  }
  return root;
}

describe("resolveInbox", () => {
  test("finds a session by uuid in the first root", () => {
    const root = fakeRoot([{ pid: 111, sessionId: "aaaaaaaa-0000-0000-0000-000000000001" }]);
    const hit = resolveInbox("aaaaaaaa-0000-0000-0000-000000000001", { roots: [root] });
    expect(hit).toEqual({ pid: 111, socketPath: "/tmp/cc-socks/111.sock", status: "idle", name: undefined });
  });
  test("scans later roots (cswap accounts) when the first misses", () => {
    const a = fakeRoot([]);
    const b = fakeRoot([{ pid: 222, sessionId: "bbbbbbbb-0000-0000-0000-000000000002", status: "busy" }]);
    expect(resolveInbox("bbbbbbbb-0000-0000-0000-000000000002", { roots: [a, b] })?.pid).toBe(222);
  });
  test("returns null for unknown uuid, missing dir, malformed json, and entry without messagingSocketPath", () => {
    const root = fakeRoot([{ pid: 333, sessionId: "cccccccc-0000-0000-0000-000000000003" }]);
    writeFileSync(join(root, "334.json"), "{not json");
    writeFileSync(join(root, "335.json"), JSON.stringify({ pid: 335, sessionId: "dddddddd-0000-0000-0000-000000000004" }));
    expect(resolveInbox("eeeeeeee-0000-0000-0000-000000000005", { roots: [root] })).toBeNull();
    expect(resolveInbox("cccccccc-0000-0000-0000-000000000003", { roots: [join(root, "missing")] })).toBeNull();
    expect(resolveInbox("dddddddd-0000-0000-0000-000000000004", { roots: [root] })).toBeNull();
  });
  test("skips a registry file whose JSON parses to a non-object without throwing", () => {
    // No matching entry at all, so every file in the root must be read
    // before resolveInbox gives up -- including the null one. A version
    // without the guard throws partway through this scan instead of
    // finishing it and returning null.
    const root = fakeRoot([]);
    writeFileSync(join(root, "337.json"), "null");
    writeFileSync(join(root, "338.json"), "42");
    expect(resolveInbox("ffffffff-0000-0000-0000-000000000006", { roots: [root] })).toBeNull();
  });
});
