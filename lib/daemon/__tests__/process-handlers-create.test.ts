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
  const released: string[] = [];
  return {
    spawned, released,
    ctx: {
      processManager: { async spawn(id: string, cmd: string, opts: any) { spawned.push({ id, cmd, opts }); }, remove() {} },
      remedyEngine: { onSpawn() {}, unregister() {} },
      portlessAvailable: () => false,
      portAllocator: { allocate: (_label: string) => 10001, releaseByLabel: (label: string) => released.push(label) },
      attachServer: { close() {} },
      logBuffer: { remove() {} },
      stateStore: { remove() {} },
    },
  };
}

describe("process:create", () => {
  test("spawns with a derived id and returns it", async () => {
    const { ctx, spawned } = ctxWith();
    const handlers = createProcessHandlers(ctx as any);
    const res = await handlers["process:create"]!({ cwd: "/a/assured-wktree-2", cmd: "vite", label: "dev" });
    expect(res.ok).toBe(true);
    expect(res.data.id).toBe("assured-wktree-2:dev");
    expect(spawned[0].id).toBe("assured-wktree-2:dev");
    expect(spawned[0].cmd).toBe("vite");
    expect(spawned[0].opts.cwd).toBe("/a/assured-wktree-2");
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
      expect(res.data.portless).toBe("unavailable");
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

  test("with portless: passes --name + --app-port and stashes PORT/PORTLESS_URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-create-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "adjuster" }));
    try {
      const { ctx, spawned } = ctxWith();
      const handlers = createProcessHandlers({ ...ctx, portlessAvailable: () => true } as any);
      const res = await handlers["process:create"]!({ cwd: dir, cmd: "vite", label: "dev" });
      expect(res.data.portless).toBe("on");
      expect(spawned[0].cmd).toBe("portless run --name adjuster --app-port 10001 vite");
      expect(spawned[0].opts.env).toEqual({ PORT: "10001", PORTLESS_URL: "https://adjuster.localhost" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("falls back to a plain run when portless is unavailable", async () => {
    const { ctx, spawned } = ctxWith();
    const handlers = createProcessHandlers({ ...ctx, portlessAvailable: () => false } as any);
    const res = await handlers["process:create"]!({ cwd: "/a/wt", cmd: "vite", label: "dev" });
    expect(res.data.portless).toBe("unavailable");
    expect(spawned[0].cmd).toBe("vite");
  });

  test("portless:false runs plain even when available", async () => {
    const { ctx, spawned } = ctxWith();
    const handlers = createProcessHandlers({ ...ctx, portlessAvailable: () => true } as any);
    const res = await handlers["process:create"]!({ cwd: "/a/wt", cmd: "vite", portless: false });
    expect(res.data.portless).toBe("off");
    expect(spawned[0].cmd).toBe("vite");
  });
});

describe("process:remove", () => {
  test("releases the allocated port and returns ok", async () => {
    const { ctx, released } = ctxWith();
    const handlers = createProcessHandlers(ctx as any);
    const res = await handlers["process:remove"]!({ id: "wt:dev" });
    expect(res.ok).toBe(true);
    expect(released).toContain("wt:dev");
  });
});

describe("worktree:commands", () => {
  test("rejects when path is missing", async () => {
    const { ctx } = ctxWith();
    const handlers = createProcessHandlers(ctx as any);
    expect((await handlers["worktree:commands"]!({})).ok).toBe(false);
  });
});
