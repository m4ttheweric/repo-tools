import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createCursorStore } from "../freshness.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rt-cursors-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createCursorStore", () => {
  test("missing file starts empty", () => {
    const store = createCursorStore(join(dir, "absent.json"));
    expect(store.get("repo-a")).toBeUndefined();
  });

  test("set persists and get round-trips", () => {
    const path = join(dir, "cursors.json");
    const store = createCursorStore(path);
    store.set("repo-a", { since: "2026-07-24T00:00:00Z", lastEventId: 42 });
    expect(store.get("repo-a")).toEqual({ since: "2026-07-24T00:00:00Z", lastEventId: 42 });

    const reloaded = createCursorStore(path);
    expect(reloaded.get("repo-a")).toEqual({ since: "2026-07-24T00:00:00Z", lastEventId: 42 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "repo-a": { since: "2026-07-24T00:00:00Z", lastEventId: 42 },
    });
  });

  test("corrupt file is treated as empty (cold start)", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json");
    const store = createCursorStore(path);
    expect(store.get("repo-a")).toBeUndefined();
    store.set("repo-a", { since: null, lastEventId: 7 });
    expect(createCursorStore(path).get("repo-a")).toEqual({ since: null, lastEventId: 7 });
  });

  test("multiple repos coexist in one file", () => {
    const path = join(dir, "cursors.json");
    const store = createCursorStore(path);
    store.set("repo-a", { since: null, lastEventId: 1 });
    store.set("repo-b", { since: null, lastEventId: 2 });
    expect(store.get("repo-a")!.lastEventId).toBe(1);
    expect(store.get("repo-b")!.lastEventId).toBe(2);
  });
});
