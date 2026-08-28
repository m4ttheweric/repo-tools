import { afterEach, expect, test } from "bun:test";
import type { RunSummary } from "../../../packages/rt-client/src/commands.ts";
import { resetLivenessCache, type AgentEntry } from "../../runs/liveness.ts";
import { startAgentStatusPoller, type AgentStatusPollerHandle } from "../agent-status-poller.ts";

const quietLog = { info: () => {}, warn: () => {} };

function runOf(id: string, status: string, agentStatus: string | null): RunSummary {
  return {
    id, repo: "acme", work_type: "t", pipeline: "p", status,
    current_stage: "implement", spawned_by: null, started_at: 1, ended_at: null,
    pack_commits: null, pack_dirty: 0,
    attention: { needs: false, reason: null, evidence: "" },
    last_event_at: 1, ticket: null, branch: null,
    agent: agentStatus ? { status: agentStatus as "working", pane: "w1:p1" } : null,
  };
}

let handle: AgentStatusPollerHandle | null = null;
afterEach(() => {
  handle?.stop();
  handle = null;
  resetLivenessCache();
});

function poller(probeResults: (AgentEntry[] | null)[], listResults: RunSummary[][]) {
  const events: unknown[] = [];
  let p = 0;
  let l = 0;
  handle = startAgentStatusPoller({
    emitEvent: (topic, payload) => events.push({ topic, payload }),
    log: quietLog,
    intervalMs: 3_600_000,
    probe: async () => probeResults[Math.min(p++, probeResults.length - 1)] ?? null,
    list: () => listResults[Math.min(l++, listResults.length - 1)] ?? [],
  });
  return { events, handle };
}

test("a status flip emits one run-updated; the seed tick emits nothing", async () => {
  const { events } = poller(
    [[], [], []],
    [[runOf("r1", "running", "working")], [runOf("r1", "running", "blocked")], [runOf("r1", "running", "blocked")]],
  );
  await handle!.tick();
  expect(events).toHaveLength(0);
  await handle!.tick();
  expect(events).toEqual([
    { topic: "run-updated", payload: { repo: "acme", runId: "r1", stage: null, kind: "agent-status" } },
  ]);
  await handle!.tick();
  expect(events).toHaveLength(1);
});

test("a failed probe holds last-known state instead of flapping to null", async () => {
  // Two list results only: the failed-probe tick must not consume one.
  const { events } = poller(
    [[], null, []],
    [[runOf("r1", "running", "working")], [runOf("r1", "running", "working")]],
  );
  await handle!.tick();
  await handle!.tick(); // probe null → tick skipped, list never consulted
  await handle!.tick(); // still working → no transition ever observed
  expect(events).toHaveLength(0);
});

test("finished runs are ignored and dropped from tracking", async () => {
  const { events } = poller(
    [[], []],
    [[runOf("r1", "running", "working")], [runOf("r1", "done", null)]],
  );
  await handle!.tick();
  await handle!.tick();
  expect(events).toHaveLength(0);
});

test("backs off the herdr probe after repeated failures", async () => {
  let probeCalls = 0;
  handle = startAgentStatusPoller({
    emitEvent: () => {},
    log: quietLog,
    intervalMs: 3_600_000,           // real timer never fires
    probe: async () => { probeCalls++; return null; }, // herdr absent
    list: () => [],
  });
  for (let i = 0; i < 20; i++) await handle.tick();
  // Without backoff this would be 20; with backoff (threshold 3, 1-in-6) far fewer.
  expect(probeCalls).toBeLessThan(10);
  // Backoff never stops probing forever: 3 initial failures engage it, then
  // one probe every BACKOFF_TICKS (ticks 9 and 15 of 20) keeps checking.
  expect(probeCalls).toBe(5);
});
