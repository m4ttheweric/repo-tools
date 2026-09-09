import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createBgClaimsStore, type BgClaimsStore } from "../bg-claims-store.ts";

const log = pino({ level: "silent" });
let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function store(dbPath?: string): { s: BgClaimsStore; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rt-bg-claims-store-"));
  dirs.push(dir);
  const path = dbPath ?? join(dir, "bg-claims.db");
  return { s: createBgClaimsStore({ dbPath: path, log }), dbPath: path };
}

describe("bg-claims-store", () => {
  test("claim then list round-trips owner and pane; release removes it", () => {
    const { s } = store();
    s.claim("herd:demo-1", "w1:p1");
    expect(s.list()).toEqual([
      { owner: "herd:demo-1", pane: "w1:p1", createdAt: expect.any(Number) },
    ]);
    expect(s.release("herd:demo-1")).toBe(true);
    expect(s.list()).toEqual([]);
  });

  test("release on an unknown owner returns false", () => {
    const { s } = store();
    expect(s.release("nope")).toBe(false);
  });

  test("claim without a pane stores pane as null", () => {
    const { s } = store();
    s.claim("runner:123");
    expect(s.list()).toEqual([{ owner: "runner:123", pane: null, createdAt: expect.any(Number) }]);
  });

  test("claim is idempotent: a second claim on the same owner does not duplicate or throw", () => {
    const { s } = store();
    s.claim("agent:rec-1", "w1:p1");
    s.claim("agent:rec-1", "w1:p1");
    expect(s.list()).toHaveLength(1);
  });

  test("releaseByPane releases only matching rows and returns the released owners", () => {
    const { s } = store();
    s.claim("herd:a", "w1:p1");
    s.claim("herd:b", "w1:p1");
    s.claim("herd:c", "w2:p1");
    const released = s.releaseByPane("w1:p1").sort();
    expect(released).toEqual(["herd:a", "herd:b"]);
    expect(s.list().map((r) => r.owner)).toEqual(["herd:c"]);
  });

  test("releaseByPane with no matches returns an empty array", () => {
    const { s } = store();
    s.claim("herd:a", "w1:p1");
    expect(s.releaseByPane("w9:p9")).toEqual([]);
    expect(s.list()).toHaveLength(1);
  });

  test("claims persist across a close and reopen of the same dbPath", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-bg-claims-store-"));
    dirs.push(dir);
    const dbPath = join(dir, "bg-claims.db");
    const s1 = createBgClaimsStore({ dbPath, log });
    s1.claim("herd:persist", "w1:p1");
    s1.close_();

    const s2 = createBgClaimsStore({ dbPath, log });
    expect(s2.list()).toEqual([{ owner: "herd:persist", pane: "w1:p1", createdAt: expect.any(Number) }]);
    s2.close_();
  });

  test("a corrupt db file is quarantined and a fresh usable db is created in its place", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-bg-claims-store-corrupt-"));
    dirs.push(dir);
    const dbPath = join(dir, "bg-claims.db");
    writeFileSync(dbPath, "garbage not sqlite");
    const s = createBgClaimsStore({ dbPath, log });
    expect(readdirSync(dir).some((f) => f.startsWith("bg-claims.db.corrupt-"))).toBe(true);
    s.claim("herd:fresh", "w1:p1");
    expect(s.list()).toEqual([{ owner: "herd:fresh", pane: "w1:p1", createdAt: expect.any(Number) }]);
    s.close_();
  });
});
