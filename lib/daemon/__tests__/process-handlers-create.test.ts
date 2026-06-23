/**
 * process:create + worktree:commands handler tests — the launch glue. The
 * discovery and id derivation are tested in worktree-commands; this covers
 * validation and that create spawns with a derived id.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProcessHandlers } from "../handlers/process.ts";

function ctxWith() {
  const spawned: any[] = [];
  return {
    spawned,
    ctx: {
      processManager: { async spawn(id: string, cmd: string, opts: any) { spawned.push({ id, cmd, opts }); } },
      remedyEngine: { onSpawn() {} },
    },
  };
}

describe("process:create", () => {
  test("spawns with a derived id and returns it", async () => {
    const { ctx, spawned } = ctxWith();
    const handlers = createProcessHandlers(ctx as any);
    const res = await handlers["process:create"]!({ cwd: "/a/acme-wktree-2", cmd: "vite", label: "dev" });
    expect(res).toEqual({ ok: true, data: { id: "acme-wktree-2:dev" } });
    expect(spawned).toEqual([{ id: "acme-wktree-2:dev", cmd: "vite", opts: { cwd: "/a/acme-wktree-2" } }]);
  });

  test("runs a named script through the detected package manager", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-create-"));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    try {
      const { ctx, spawned } = ctxWith();
      const handlers = createProcessHandlers(ctx as any);
      const res = await handlers["process:create"]!({ cwd: dir, script: "gentypes" });
      expect(res.ok).toBe(true);
      expect(spawned[0].cmd).toBe("pnpm run gentypes"); // NOT the raw script body
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects when cwd or both cmd and script are missing", async () => {
    const { ctx } = ctxWith();
    const handlers = createProcessHandlers(ctx as any);
    expect((await handlers["process:create"]!({ script: "dev" })).ok).toBe(false);
    expect((await handlers["process:create"]!({ cwd: "/a" })).ok).toBe(false);
  });
});

describe("worktree:commands", () => {
  test("rejects when path is missing", async () => {
    const { ctx } = ctxWith();
    const handlers = createProcessHandlers(ctx as any);
    expect((await handlers["worktree:commands"]!({})).ok).toBe(false);
  });
});
