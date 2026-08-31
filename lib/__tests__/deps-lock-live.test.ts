import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../bundle-layout.ts";

const lock = parseDepsLock(
  readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"),
);

describe("live deps.lock buildable set", () => {
  test("every managed app row carries its m4ttstack repo", () => {
    const want: Record<string, string> = {
      deck: "m4ttstack/deck",
      board: "m4ttstack/mr-board",
      gitq: "m4ttstack/gitq",
      console: "m4ttstack/console",
      chat: "m4ttstack/chat",
    };
    for (const [name, repo] of Object.entries(want)) {
      const row = lock.tools.find((t) => t.name === name);
      expect(row, name).toBeDefined();
      expect(row!.repo, name).toBe(repo);
    }
  });

  test("repo-bearing rows are fully pinned or explicitly pending", () => {
    for (const t of lock.tools) {
      if (!t.repo) continue;
      if (t.status === "bundled") {
        expect(t.url, t.name).toMatch(/^https:\/\/github\.com\/m4ttstack\//);
        expect(t.sha256, t.name).toMatch(/^[0-9a-f]{64}$/);
        expect(t.version, t.name).not.toBe("");
      } else {
        expect(t.url, t.name).toBe("");
      }
    }
  });

  test("third-party pins carry no repo", () => {
    for (const name of ["fzf", "jq", "node", "bun", "cloudflared", "sparkle"]) {
      expect(lock.tools.find((t) => t.name === name)?.repo, name).toBeUndefined();
    }
  });
});
