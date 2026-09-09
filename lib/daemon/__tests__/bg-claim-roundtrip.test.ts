/**
 * End-to-end claim convention check: the two production seams that touch a
 * `--bg` agent claim (createAgentHandlers' agent:start and
 * createHerdLifecycle's pane.closed/pane.exited handling) must agree on the
 * exact ref string without either side hardcoding it. Both run for real
 * here, against one real BgClaimsStore -- no fakes standing in for either.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pino from "pino";
import { openStateDb } from "../../state/index.ts";
import { parsePaneRef } from "../../../packages/rt-client/src/index.ts";
import type { HerdrRunner } from "../../agent-herdr.ts";
import { createAgentHandlers } from "../handlers/agent.ts";
import { createBgClaimsStore } from "../bg-claims-store.ts";
import { createHerdStore } from "../herd-store.ts";
import { createGatesStore } from "../gates-store.ts";
import { createEventsBus } from "../events-bus.ts";
import { createGateHandlers } from "../handlers/gate.ts";
import { createHerdLifecycle } from "../herd-lifecycle.ts";

const log = pino({ level: "silent" });
const REPO = "remote:example.com%2Fa%2Fb";
const BG_SOCKET = "/bg.sock";

const bgSocketRunner: HerdrRunner = async (args) => {
  if (args[0] === "workspace" && args[1] === "list") return { stdout: JSON.stringify({ result: { workspaces: [] } }), exitCode: 0 };
  if (args[0] === "workspace" && args[1] === "create") {
    return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } } }), exitCode: 0 };
  }
  return { stdout: "{}", exitCode: 0 };
};

test("agent:start --bg claims via the real store, and a bg-socket pane.closed through the real lifecycle releases it -- one claim, then zero, no hardcoded refs on either side", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-bg-claim-rt-"));
  try {
    const stateDb = openStateDb(join(dir, "state.db"));
    const bgClaims = createBgClaimsStore({ dbPath: join(dir, "bg-claims.db"), log });
    const herdStore = createHerdStore({ dbPath: join(dir, "herds.db"), log });
    const gatesStore = createGatesStore({ dbPath: join(dir, "gates.db"), log });
    const bus = createEventsBus({ dbPath: join(dir, "events.db"), log });
    const gate = createGateHandlers(gatesStore, bus, (type, data) => bus.fanOut(type, data), { log });
    const chat = { "chat:post": async () => ({ ok: true as const, data: { id: 1, recipients: [], others: 0 } }) };
    const lifecycle = createHerdLifecycle({
      store: herdStore, gate, chat, bus, gateStore: gatesStore,
      defaultSocket: "/default.sock", bgSocket: BG_SOCKET, bgClaims,
      log,
    });

    const agentHandlers = createAgentHandlers({
      db: stateDb,
      emitEvent: () => 0,
      herdrRunnerForSocket: () => bgSocketRunner,
      bg: { ensure: async () => ({ socket: BG_SOCKET, started: true }), reprobe: async () => ({ ok: true, drift: [] }) },
      bgClaims,
      lifecycle,
    });

    const started = await agentHandlers["agent:start"]({ repo: REPO, cwd: "/tmp/x", prompt: "hi", bg: true });
    if (!started.ok) throw new Error(started.error);

    // Neither seam is told the ref in advance: agent:start's own
    // formatPaneRef(bare, "bg") minted it, and this assertion reads it back
    // off the real store row -- not a literal typed by the test.
    const paneRef = started.data.paneId;
    if (!paneRef) throw new Error("agent:start --bg did not record a paneId");

    expect(bgClaims.list()).toHaveLength(1);
    const [row] = bgClaims.list();
    expect(row!.owner).toBe(`agent:${started.data.id}`);
    expect(row!.pane).toBe(paneRef);

    const bare = parsePaneRef(paneRef).paneId;
    await lifecycle.handleEvent(BG_SOCKET, { type: "pane.closed", pane_id: bare });

    expect(bgClaims.list()).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
