import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { repoDataDir } from "../../rt-paths.ts";
import { loadClaims } from "../../endpoint/store.ts";
import { createEndpointHandlers, releaseEndpointsForWorktree } from "../handlers/endpoint.ts";
import type { HandlerContext } from "../handlers/types.ts";

const ctx = { log: pino({ level: "silent" }) } as unknown as HandlerContext;
const fakeProbes = async () => ({ listeners: new Set<number>(), pidAlive: () => true, canBind: () => true });

function declareRoles(repo: string): void {
  mkdirSync(repoDataDir(repo), { recursive: true });
  writeFileSync(join(repoDataDir(repo), "config.json"), JSON.stringify({
    roles: {
      backend: { pool: [{ from: 10400, to: 10402 }], env: { PORT: "${port}" } },
      portal: { pool: [4001, 5001], needs: ["backend"] },
    },
  }));
}

describe("endpoint handlers", () => {
  let handlers: ReturnType<typeof createEndpointHandlers>;
  beforeEach(() => { handlers = createEndpointHandlers(ctx, { probes: fakeProbes }); });

  test("claim allocates, lookup sees it, refs pull the needed role into existence", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: "repoA", worktree: "/wt/a", role: "portal", pid: 7 });
    expect(r.ok).toBe(true);
    expect(r.data.port).toBe(4001);
    expect(r.data.url).toBe("http://localhost:4001");
    expect(r.data.refs.backend.port).toBe(10400);
    const lk = await handlers["endpoint:lookup"]({ repo: "repoA", worktree: "/wt/a", role: "backend" });
    expect(lk.data).toMatchObject({ claimed: true, port: 10400 });
  });

  test("unknown role and unknown repo fail with named errors", async () => {
    declareRoles("repoA");
    const r = await handlers["endpoint:claim"]({ repo: "repoA", worktree: "/wt/a", role: "nope" });
    expect(r).toMatchObject({ ok: false, error: 'role "nope" is not declared for repo "repoA"' });
  });

  test("release by worktree frees claims; releaseEndpointsForWorktree does the same (disposal path)", async () => {
    declareRoles("repoB");
    await handlers["endpoint:claim"]({ repo: "repoB", worktree: "/wt/x", role: "backend", pid: 1 });
    releaseEndpointsForWorktree(ctx, "repoB", "/wt/x");
    expect(loadClaims("repoB")).toEqual([]);
  });
});
