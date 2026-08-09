/**
 * MAT-222: the sandbox reconcile tick shares the daemon event loop with the
 * API and socket servers, so a misbehaving controller connection must fail
 * the pass — never wedge it. The live wedge's controller sat behind a
 * kubectl port-forward, whose pathology is exactly "accept the connection,
 * answer nothing": an unbounded fetch on that connection never settles, the
 * pass never finishes, and the sync is dead until restart.
 *
 * Shapes here mirror the live forensics: sandbox in `creating`, two events
 * (state + evidence-failed), one failed evidence request.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createForwardSet, createSandboxSync } from "../sandbox-allocator.ts";
import {
  createSandboxClient,
  writeSandboxAnchor,
  type EvidenceRequestRecord,
  type SandboxDetail,
  type SandboxEvent,
  type SandboxOverlayConfig,
} from "../sandbox.ts";
import { createEvidenceLedger } from "../daemon/evidence-ledger.ts";

const ORIG_HOME = process.env.HOME;
afterEach(() => { process.env.HOME = ORIG_HOME; });

const SANDBOX_ID = "0b707c06-03d4-49da-8d81-f007d890d639";
const REPO = "assured-dev";
const REQUEST_ID = "869a475c-e5a5-4305-b190-bc0431abeb93";

const CONFIG: SandboxOverlayConfig = {
  processes: [
    { name: "backend", port: 4000, localPorts: [4000] },
    { name: "adjuster", port: 4001, localPorts: [4001] },
  ],
};

const DETAIL: SandboxDetail = {
  id: SANDBOX_ID, repoId: REPO, branch: "mc-e2e-evidence", imageTag: "nightly",
  state: "creating", createdAt: "2026-08-08T23:16:43.903Z",
  ports: { backend: 4000, adjuster: 4001 }, lastEventSeq: 2, podPhase: "Pending",
};

const EVENTS: SandboxEvent[] = [
  { seq: 1, ts: "t1", sandboxId: SANDBOX_ID, type: "state", payload: { state: "seeding" } },
  { seq: 2, ts: "t2", sandboxId: SANDBOX_ID, type: "evidence-failed", payload: { requestId: REQUEST_ID, error: { code: "before-timeout" } } },
];

const FAILED_REQUEST: EvidenceRequestRecord = {
  id: REQUEST_ID, sandboxId: SANDBOX_ID, caseId: "case-1", view: "cvi-case",
  recipe: "viewport", args: {}, slot: "before", state: "failed",
  requestedBy: "controller", forceBefore: false, error: { code: "before-timeout" },
  createdAt: "2026-08-08T23:16:43.911Z", updatedAt: "2026-08-08T23:26:43.937Z", syncedAt: null,
};

function tempHomeWithAnchor(lastEventSeq: number): void {
  process.env.HOME = mkdtempSync(join(tmpdir(), "rt-wedge-home-"));
  writeSandboxAnchor({
    id: SANDBOX_ID, repoId: REPO, branch: "mc-e2e-evidence",
    createdAt: "2026-08-08T23:16:43.878Z", lastEventSeq,
  });
}

function makeSync(client: ReturnType<typeof createSandboxClient>, notifications: string[]) {
  const ledger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-wedge-led-")), "ledger.json"));
  const sync = createSandboxSync({
    probe: async () => true,
    client,
    forwards: createForwardSet(() => ({ kill() {} })),
    notify: (title) => { notifications.push(title); },
    overlays: () => [{ repoId: REPO, config: CONFIG }],
    evidence: { ledger, sync: async () => {} },
  });
  return { sync, ledger };
}

describe("sandbox sync vs a wedged controller connection (MAT-222)", () => {
  test(
    "a connection that accepts but never answers fails the pass instead of wedging it",
    async () => {
      tempHomeWithAnchor(2);

      // The port-forward pathology: /healthz answers fast (a fresh curl saw
      // "fast 200s" during the live wedge), everything else hangs forever.
      const server = Bun.serve({
        port: 0,
        idleTimeout: 0,
        fetch(req) {
          if (new URL(req.url).pathname === "/healthz") return Response.json({ ok: true });
          return new Promise<Response>(() => { /* never answers */ });
        },
      });

      try {
        const client = createSandboxClient(`http://localhost:${server.port}`, fetch, { timeoutMs: 500 });
        const notifications: string[] = [];
        const { sync } = makeSync(client, notifications);

        const outcome = await Promise.race([
          sync.syncOnce().then(() => "settled"),
          new Promise<string>((r) => setTimeout(() => r("wedged"), 5000)),
        ]);
        expect(outcome).toBe("settled");
      } finally {
        server.stop(true);
      }
    },
    10_000,
  );

  test(
    "the exact live shape completes promptly and never starves concurrent work",
    async () => {
      tempHomeWithAnchor(0);

      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/healthz") return Response.json({ ok: true });
          if (path === "/sandboxes") return Response.json([DETAIL]);
          if (path === `/sandboxes/${SANDBOX_ID}/events`) {
            const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
            return Response.json(EVENTS.filter((e) => e.seq > since));
          }
          if (path === `/sandboxes/${SANDBOX_ID}/evidence`) return Response.json([FAILED_REQUEST]);
          if (path === `/evidence/${REQUEST_ID}`) return Response.json({ ...FAILED_REQUEST, artifacts: [] });
          return new Response("not found", { status: 404 });
        },
      });

      try {
        const client = createSandboxClient(`http://localhost:${server.port}`, fetch, { timeoutMs: 2000 });
        const notifications: string[] = [];
        const { sync, ledger } = makeSync(client, notifications);

        // A request served concurrently with the pass must complete — the
        // sync tick shares the event loop with the API/socket servers.
        const t0 = Date.now();
        const concurrent = fetch(`http://localhost:${server.port}/healthz`);
        await sync.syncOnce();
        const passMs = Date.now() - t0;

        expect(passMs).toBeLessThan(2000);
        expect((await concurrent).ok).toBe(true);
        // evidence-failed fanned out: notification fired, ledger entry
        // materialized from the controller's request list with state failed.
        expect(notifications).toContain("Evidence capture failed");
        expect(ledger.read(REQUEST_ID)?.state).toBe("failed");
      } finally {
        server.stop(true);
      }
    },
    10_000,
  );
});
