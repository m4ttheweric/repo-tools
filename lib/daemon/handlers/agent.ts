/**
 * agent:* ... daemon handlers for `rt agent` (launch + record + resume; no
 * liveness by design - spec 2026-08-25).
 *
 * Session uuids are minted here and validated in lib/agent-argv.ts before
 * any spawn; resume always runs under the RECORDED account because claude
 * transcripts are per-cswap-profile.
 */

import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import {
  deleteAgent, finishAgent, getAgent, insertAgent, listAgents, markAgentResumed,
  newAgentId, reserveAgentHandle, updateAgentPane, type AgentRecord, type AgentSurface,
} from "../../state/index.ts";
import { buildClaudeArgv, buildPaneCommand, type ClaudeInvocation } from "../../agent-argv.ts";
import { defaultHerdrRunner, launchInWorkspace, type HerdrRunner } from "../../agent-herdr.ts";
import { repoLabel } from "../../repo-arg.ts";
import { getSetting } from "../../settings/resolve.ts";
import { rtDir } from "../../rt-paths.ts";
import { lazyChildLogger } from "../../daemon-logger.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult, TypedHandlers } from "./types.ts";

export interface HeadlessChild {
  exited: Promise<number>;
  stdout: () => Promise<string>;
}

function defaultSpawnHeadless(argv: string[], cwd: string): HeadlessChild {
  const proc = Bun.spawn(argv as [string, ...string[]], {
    cwd,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    exited: proc.exited,
    stdout: () => new Response(proc.stdout).text(),
  };
}

/** A declared+unset key resolves undefined without throwing, so a caught error here is already the unexpected case. */
function fromSetting(key: string, log: Logger): string | undefined {
  try {
    return getSetting<string>(key).value ?? undefined;
  } catch (err) {
    log.warn({ err, key }, "agent: settings read failed");
    return undefined;
  }
}

/** Deterministic from the id alone, so it can be known and stored before the headless process is even spawned. */
function agentResultPath(id: string): string {
  return join(rtDir(), "agents", `${id}.json`);
}

export function createAgentHandlers(opts: {
  db: Database;
  emitEvent: (topic: string, payload?: unknown) => unknown;
  /** Daemon logger, wired from the router's ctx.log; falls back to a lazy child logger for callers (tests) that construct handlers directly. */
  log?: Logger;
  herdrRunner?: HerdrRunner;
  spawnHeadless?: (argv: string[], cwd: string) => HeadlessChild;
  insertAgentFn?: typeof insertAgent;
}): Pick<TypedHandlers, "agent:start" | "agent:resume" | "agent:get" | "agent:list"> & { db: Database } {
  const { db, emitEvent } = opts;
  const log = opts.log ?? lazyChildLogger("agent");
  const spawnHeadless = opts.spawnHeadless ?? defaultSpawnHeadless;
  const insertAgentFn = opts.insertAgentFn ?? insertAgent;

  async function launch(
    rec: AgentRecord,
    session: ClaudeInvocation["session"],
    prompt: string | undefined,
    tabLabel: string,
    workspaceLabel: string,
  ): Promise<CommandResult<"agent:start">> {
    const inv: ClaudeInvocation = {
      session,
      headless: rec.surface === "headless",
      ...(rec.account !== undefined && { account: rec.account }),
      ...(rec.model !== undefined && { model: rec.model }),
      ...(rec.effort !== undefined && { effort: rec.effort }),
      ...(rec.handle !== undefined && { name: rec.handle }),
      ...(rec.extraArgs !== undefined && { extraArgs: rec.extraArgs }),
      ...(prompt !== undefined && { prompt }),
    };

    if (rec.surface === "herdr") {
      const runner = opts.herdrRunner ?? defaultHerdrRunner();
      const out = await launchInWorkspace(
        { workspaceLabel, tabLabel, paneCommand: buildPaneCommand(rec.cwd, inv) },
        runner,
      );
      if (!out.focusedExisting) {
        rec.paneId = out.paneId;
        rec.tabId = out.tabId;
        rec.workspaceId = out.workspaceId;
      }
      return { ok: true, data: rec };
    }

    const argv = buildClaudeArgv(inv);
    const resultPath = agentResultPath(rec.id);
    rec.resultPath = resultPath;
    mkdirSync(dirname(resultPath), { recursive: true });
    // The caller inserts rec before invoking launch() for every headless
    // path (start and resume alike), so the row already exists here --
    // finishAgent below can never race an insert that hasn't happened yet.
    const child = spawnHeadless(argv, rec.cwd);
    void child.exited.then(async (exitCode) => {
      try {
        writeFileSync(resultPath, await child.stdout());
      } catch (err) {
        log.warn({ err, id: rec.id }, "agent: failed to persist headless result body");
      }
      finishAgent(rec.id, { exitCode, resultPath, finishedAt: Date.now() }, db);
      emitEvent(`agent/done/${rec.id}`, { exitCode });
    });
    return { ok: true, data: rec };
  }

  return {
    db,

    "agent:start": async (payload: Commands["agent:start"]["payload"]): Promise<CommandResult<"agent:start">> => {
      const { repo, cwd } = payload;
      if (!repo || !cwd) return { ok: false, error: "agent:start requires repo (serialized identity) and cwd" };
      const surface: AgentSurface = payload.surface ?? "herdr";
      const prompt = payload.prompt;
      if (surface === "headless" && !prompt) {
        return { ok: false, error: "headless launch requires a prompt (claude -p with no prompt blocks on stdin)" };
      }
      const rec: AgentRecord = {
        id: newAgentId(),
        repo, cwd, provider: "claude", surface,
        sessionId: crypto.randomUUID(),
        createdAt: Date.now(),
      };
      const model = payload.model ?? fromSetting("agent.model", log);
      const effort = payload.effort ?? fromSetting("agent.effort", log);
      const account = payload.account ?? fromSetting("agent.account", log);
      const extraArgs = payload.extraArgs ?? fromSetting("agent.extraArgs", log);
      if (model !== undefined) rec.model = model;
      if (effort !== undefined) rec.effort = effort;
      if (account !== undefined) rec.account = account;
      if (extraArgs !== undefined) rec.extraArgs = extraArgs;
      if (payload.label !== undefined) rec.label = payload.label;
      if (payload.caller !== undefined) rec.caller = payload.caller;
      if (surface === "headless") {
        rec.resultPath = agentResultPath(rec.id);
      } else {
        // Headless never signs into chat (see claudeArgs), so reserving a
        // handle for it would only burn an LRU pool slot no one adopts.
        rec.handle = reserveAgentHandle(db);
      }

      const tabLabel = payload.tab ?? rec.label ?? rec.id;
      const workspaceLabel = payload.workspace ?? repoLabel(repo);
      try {
        // Inserted before launch() runs, not after: launch()'s headless
        // branch arms a completion callback that calls finishAgent, and
        // that row must already exist or the update is a silent no-op.
        // A launch failure below rolls this insert back so no phantom,
        // never-launched record survives it (unlike agent:resume, whose
        // record predates the call and must never be deleted on failure).
        insertAgentFn(rec, db);
        // insertAgent goes through runCriticalWrite: sustained SQLITE_BUSY
        // logs and returns without throwing, so the insert can silently not
        // have happened. Confirm the row exists before ever spawning.
        if (!getAgent(rec.id, db)) {
          return { ok: false, error: "state.db busy: agent not recorded, not launched" };
        }
        const res = await launch(rec, { kind: "start", sessionId: rec.sessionId }, prompt, tabLabel, workspaceLabel);
        if (!res.ok) {
          deleteAgent(rec.id, db);
          return res;
        }
        if (surface === "herdr" && rec.paneId && rec.tabId && rec.workspaceId) {
          updateAgentPane(rec.id, { paneId: rec.paneId, tabId: rec.tabId, workspaceId: rec.workspaceId }, db);
        }
        return res;
      } catch (err) {
        deleteAgent(rec.id, db);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "agent:resume": async (payload: Commands["agent:resume"]["payload"]): Promise<CommandResult<"agent:resume">> => {
      const rec = getAgent(payload.id, db);
      if (!rec) return { ok: false, error: `no agent record for "${payload.id}"` };
      const surface: AgentSurface = payload.surface ?? rec.surface;
      if (surface === "headless" && !payload.prompt) {
        return { ok: false, error: "headless resume requires a prompt (claude -p with no prompt blocks on stdin)" };
      }
      // ↺ prefix: resume tabs must never dedup against the still-open launch
      // tab; repeated resumes share the label and dedup against each other.
      const tabLabel = payload.tab ?? `↺ ${rec.label ?? rec.id}`;
      const workspaceLabel = payload.workspace ?? repoLabel(rec.repo);
      const attempt: AgentRecord = { ...rec, surface };
      try {
        const res = await launch(attempt, { kind: "resume", sessionId: rec.sessionId }, payload.prompt, tabLabel, workspaceLabel);
        if (!res.ok) return res;
        const now = Date.now();
        markAgentResumed(rec.id, now, db);
        if (surface === "herdr" && attempt.paneId && attempt.tabId && attempt.workspaceId) {
          updateAgentPane(rec.id, { paneId: attempt.paneId, tabId: attempt.tabId, workspaceId: attempt.workspaceId }, db);
        }
        return { ok: true, data: { ...(getAgent(rec.id, db) ?? attempt) } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "agent:get": async (payload: Commands["agent:get"]["payload"]): Promise<CommandResult<"agent:get">> => {
      const rec = getAgent(payload.id, db);
      return rec ? { ok: true, data: rec } : { ok: false, error: `no agent record for "${payload.id}"` };
    },

    "agent:list": async (payload: Commands["agent:list"]["payload"]): Promise<CommandResult<"agent:list">> => {
      return { ok: true, data: { agents: listAgents({ ...(payload.repo !== undefined && { repo: payload.repo }) }, db) } };
    },
  };
}
