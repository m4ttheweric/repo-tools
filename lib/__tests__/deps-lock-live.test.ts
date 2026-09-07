import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDepsLock } from "../bundle-layout.ts";

const lock = parseDepsLock(
  readFileSync(join(import.meta.dir, "..", "..", "rt-tray", "deps.lock"), "utf8"),
);

describe("live deps.lock buildable set", () => {
  test("every managed app row carries its m4ttstack repo (monorepo apps carry their subdir)", () => {
    const want: Record<string, { repo: string; subdir?: string }> = {
      deck: { repo: "m4ttstack/apps", subdir: "apps/deck" },
      board: { repo: "m4ttstack/apps", subdir: "apps/board" },
      gitq: { repo: "m4ttstack/gitq" },
      console: { repo: "m4ttstack/apps", subdir: "apps/console" },
      chat: { repo: "m4ttstack/apps", subdir: "apps/chat" },
    };
    for (const [name, w] of Object.entries(want)) {
      const row = lock.tools.find((t) => t.name === name);
      expect(row, name).toBeDefined();
      expect(row!.repo, name).toBe(w.repo);
      expect(row!.subdir, name).toBe(w.subdir);
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
    for (const name of ["jq", "node", "bun", "cloudflared", "sparkle"]) {
      expect(lock.tools.find((t) => t.name === name)?.repo, name).toBeUndefined();
    }
  });
});
