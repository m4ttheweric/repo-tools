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
  deleteAgent, finishAgent, getAgent, insertAgent, isValidChatName, listAgents, markAgentResumed,
  newAgentId, reserveAgentHandle, updateAgentPane, type AgentRecord, type AgentSurface,
} from "../../state/index.ts";
import { buildClaudeArgv, buildPaneCommand, type ClaudeInvocation } from "../../agent-argv.ts";
import { defaultHerdrRunner, launchInWorkspace, type HerdrRunner } from "../../agent-herdr.ts";
import { repoLabel } from "../../repo-label.ts";
import { getSetting } from "../../settings/resolve.ts";
import { rtDir } from "../../rt-paths.ts";
import { lazyChildLogger } from "../../daemon-logger.ts";
import { formatPaneRef, parsePaneRef } from "../../../packages/rt-client/src/index.ts";
import type { Commands } from "../../../packages/rt-client/src/commands.ts";
import { bgSocketPath } from "../bg-service.ts";
import type { BgService } from "../bg-service.ts";
import type { BgClaimsStore } from "../bg-claims-store.ts";
import type { CommandResult } from "./types.ts";

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

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string");
}

// buildPaneCommand interpolates the key into the pane's shell line raw (only
// the value is quoted), so anything but a shell-inert identifier is injection.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const agentOwner = (id: string): string => `agent:${id}`;

/** herdr invoked against a freshly-spawned bg server can fail before any pane
    ever runs: the bg env's PATH may not carry herdr's own binary yet
    (`bin not found at ...`) or herdr's own process exits 127 resolving it.
    Only that shape is worth a reprobe; any other launch failure (dedup,
    workspace/tab RPC errors) reprobing would not explain. */
function isCommandNotFoundShape(message: string): boolean {
  return /\(127\)/.test(message) || /not found at/i.test(message);
}

export function createAgentHandlers(opts: {
  db: Database;
  emitEvent: (topic: string, payload?: unknown) => unknown;
  /** Daemon logger, wired from the router's ctx.log; falls back to a lazy child logger for callers (tests) that construct handlers directly. */
  log?: Logger;
  herdrRunner?: HerdrRunner;
  herdrRunnerForSocket?: (socket: string) => HerdrRunner;
  spawnHeadless?: (argv: string[], cwd: string) => HeadlessChild;
  insertAgentFn?: typeof insertAgent;
  /** The daemon-owned background herdr server `--bg` launches onto (spec "The bg service"). Omitted, `bg: true` is refused. */
  bg?: Pick<BgService, "ensure" | "reprobe">;
  bgClaims?: Pick<BgClaimsStore, "claim" | "releaseByPane">;
  /** herd-lifecycle.ts's watch is idempotent by socket, so an already-watched bg socket is a no-op here. */
  lifecycle?: { watch(socket: string): void };
}):
  // Direct `unknown`-payload members, not `Pick<TypedHandlers, ...>`: a wider
  // `unknown` param still satisfies TypedHandlers' narrower one at the
  // command-router.ts assembly site (function parameter contravariance).
  & { "agent:start": (payload: unknown) => Promise<CommandResult<"agent:start">> }
  & { "agent:resume": (payload: unknown) => Promise<CommandResult<"agent:resume">> }
  & { "agent:get": (payload: unknown) => Promise<CommandResult<"agent:get">> }
  & { "agent:list": (payload: unknown) => Promise<CommandResult<"agent:list">> } {
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
    extra: { env?: Record<string, string>; herdrSocket?: string } = {},
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
      ...(extra.env !== undefined && { env: extra.env }),
    };

    if (rec.surface === "herdr") {
      const runner = extra.herdrSocket
        ? (opts.herdrRunnerForSocket ?? ((socket: string) => defaultHerdrRunner({ ...process.env, HERDR_SOCKET_PATH: socket })))(extra.herdrSocket)
        : (opts.herdrRunner ?? defaultHerdrRunner());
      const out = await launchInWorkspace(
        { workspaceLabel, tabLabel, paneCommand: buildPaneCommand(rec.cwd, inv) },
        runner,
      );
      if (out.focusedExisting) {
        // A live tab already answers to this label: launchInWorkspace
        // focused it and ran nothing. Reporting ok:true here would insert a
        // record with a freshly minted sessionId nothing is listening on —
        // rt agent resume against it would run `claude --resume` for a
        // session that was never started.
        return { ok: false, error: `tab "${tabLabel}" already open; focused it` };
      }
      rec.paneId = out.paneId;
      rec.tabId = out.tabId;
      rec.workspaceId = out.workspaceId;
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
    "agent:start": async (rawPayload: unknown): Promise<CommandResult<"agent:start">> => {
      if (!rawPayload || typeof rawPayload !== "object") return { ok: false, error: "agent:start requires an object payload" };
      const payload = rawPayload as Commands["agent:start"]["payload"];
      const { repo, cwd } = payload;
      if (!repo || !cwd) return { ok: false, error: "agent:start requires repo (serialized identity) and cwd" };
      if (payload.surface !== undefined && payload.surface !== "herdr" && payload.surface !== "headless") {
        return { ok: false, error: `invalid surface "${payload.surface}"; must be one of herdr, headless` };
      }
      const surface: AgentSurface = payload.surface ?? "herdr";
      if (payload.bg && surface === "headless") {
        return { ok: false, error: "--bg is a herdr-surface option" };
      }
      if (payload.bg && (!opts.bg || !opts.bgClaims || !opts.lifecycle)) {
        return { ok: false, error: "bg launches require the rt daemon (rt daemon start)" };
      }
      const prompt = payload.prompt;
      if (surface === "headless" && !prompt) {
        return { ok: false, error: "headless launch requires a prompt (claude -p with no prompt blocks on stdin)" };
      }
      if (payload.env !== undefined && !isStringRecord(payload.env)) {
        return { ok: false, error: "env must be an object of strings" };
      }
      if (payload.env !== undefined && !Object.keys(payload.env).every((k) => ENV_KEY_RE.test(k))) {
        return { ok: false, error: "invalid env key" };
      }
      // Headless spawns argv directly (no pane shell line for buildPaneCommand
      // to interpolate env into), so a silently dropped env would run without
      // the variables the caller thinks it passed.
      if (payload.env !== undefined && surface === "headless") {
        return { ok: false, error: "env is only supported for the herdr surface" };
      }
      if (payload.handle !== undefined && !isValidChatName(payload.handle)) {
        return { ok: false, error: "invalid handle" };
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
      } else if (payload.handle) {
        rec.handle = payload.handle;
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
        // Awaited before launch, not folded into the launch() extras spread:
        // a failed ensure must roll the insert back the same way a failed
        // launch does, and the socket has to be known before launch runs.
        let bgSocket: string | undefined;
        if (payload.bg) {
          const ensured = await opts.bg!.ensure();
          bgSocket = ensured.socket;
          opts.lifecycle!.watch(ensured.socket);
        }
        const effectiveSocket = bgSocket ?? payload.herdrSocket;
        const res = await launch(rec, { kind: "start", sessionId: rec.sessionId }, prompt, tabLabel, workspaceLabel, {
          ...(payload.env !== undefined && { env: payload.env }),
          ...(effectiveSocket !== undefined && { herdrSocket: effectiveSocket }),
        });
        if (!res.ok) {
          deleteAgent(rec.id, db);
          return res;
        }
        // A herd-spawned hidden worker rides the bg socket via herdrSocket,
        // never payload.bg (its claim is the herd's own, not this record's);
        // the ref must still store bg: or agent:resume's wasBg check misses
        // it and relaunches on the visible server. `payload.bg` stays the
        // primary signal (production and every faked-socket test agree on
        // it); the socket-equality check only widens it to the flagless
        // herd:spawn path, where the effective socket really is bgSocketPath().
        if ((payload.bg || effectiveSocket === bgSocketPath()) && rec.paneId) {
          // The pane column and AgentRecord.paneId both store the ref, never
          // the bare pane id: releaseByPane is later called with this same
          // string, and renderRecord/agent:get print it back verbatim.
          rec.paneId = formatPaneRef(rec.paneId, "bg");
        }
        if (payload.bg && rec.paneId) {
          opts.bgClaims!.claim(agentOwner(rec.id), rec.paneId);
        }
        if (surface === "herdr" && rec.paneId && rec.tabId && rec.workspaceId) {
          updateAgentPane(rec.id, { paneId: rec.paneId, tabId: rec.tabId, workspaceId: rec.workspaceId }, db);
        }
        return res;
      } catch (err) {
        deleteAgent(rec.id, db);
        const message = err instanceof Error ? err.message : String(err);
        if (payload.bg && opts.bg && isCommandNotFoundShape(message)) {
          // Advisory only: the failure this branch handles is exactly the
          // case where the bg server may be unhealthy, so the reprobe itself
          // can reject. A reprobe rejection must not replace the launch
          // error the caller actually needs.
          let drift = "";
          try {
            const report = await opts.bg.reprobe();
            if (report.drift.length > 0) drift = `; bg env drift: ${report.drift.join("; ")}`;
          } catch (probeErr) {
            log.warn({ err: probeErr, id: rec.id }, "agent: bg reprobe failed after launch error");
          }
          return { ok: false, error: `${message}${drift}` };
        }
        return { ok: false, error: message };
      }
    },

    "agent:resume": async (rawPayload: unknown): Promise<CommandResult<"agent:resume">> => {
      const payload = rawPayload as Commands["agent:resume"]["payload"];
      const rec = getAgent(payload.id, db);
      if (!rec) return { ok: false, error: `no agent record for "${payload.id}"` };
      if (payload.surface !== undefined && payload.surface !== "herdr" && payload.surface !== "headless") {
        return { ok: false, error: `invalid surface "${payload.surface}"; must be one of herdr, headless` };
      }
      const surface: AgentSurface = payload.surface ?? rec.surface;
      if (surface === "headless" && !payload.prompt) {
        return { ok: false, error: "headless resume requires a prompt (claude -p with no prompt blocks on stdin)" };
      }
      // ↺ prefix: resume tabs must never dedup against the still-open launch
      // tab; repeated resumes share the label and dedup against each other.
      const tabLabel = payload.tab ?? `↺ ${rec.label ?? rec.id}`;
      const workspaceLabel = payload.workspace ?? repoLabel(rec.repo);
      const attempt: AgentRecord = { ...rec, surface };
      // A record whose paneId is a bg: ref was launched on the background
      // server; resuming it must follow it there, or the new pane lands on
      // the visible server while the record still claims to be backgrounded.
      // Surface can be overridden away from herdr on resume (headless has no
      // pane at all), so the bg path only applies when it stays herdr.
      const oldRef = rec.paneId;
      const wasBg = surface === "herdr" && oldRef !== undefined && parsePaneRef(oldRef).server === "bg";
      if (wasBg && (!opts.bg || !opts.bgClaims || !opts.lifecycle)) {
        return { ok: false, error: "bg launches require the rt daemon (rt daemon start)" };
      }
      try {
        let bgSocket: string | undefined;
        if (wasBg) {
          const ensured = await opts.bg!.ensure();
          bgSocket = ensured.socket;
          opts.lifecycle!.watch(ensured.socket);
        }
        const res = await launch(attempt, { kind: "resume", sessionId: rec.sessionId }, payload.prompt, tabLabel, workspaceLabel, {
          ...(bgSocket !== undefined && { herdrSocket: bgSocket }),
        });
        if (!res.ok) return res;
        const now = Date.now();
        markAgentResumed(rec.id, now, db);
        if (wasBg && attempt.paneId) {
          // Same owner, new pane: release the stale claim by the exact ref
          // it was registered under (releaseByPane's own convention), then
          // reclaim under the new ref before it is ever stored, so the DB
          // row and the claim agree from the same instant onward.
          opts.bgClaims!.releaseByPane(oldRef!);
          attempt.paneId = formatPaneRef(attempt.paneId, "bg");
          opts.bgClaims!.claim(agentOwner(rec.id), attempt.paneId);
        }
        if (surface === "herdr" && attempt.paneId && attempt.tabId && attempt.workspaceId) {
          updateAgentPane(rec.id, { paneId: attempt.paneId, tabId: attempt.tabId, workspaceId: attempt.workspaceId }, db);
        }
        return { ok: true, data: { ...(getAgent(rec.id, db) ?? attempt) } };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    "agent:get": async (rawPayload: unknown): Promise<CommandResult<"agent:get">> => {
      const payload = rawPayload as Commands["agent:get"]["payload"];
      const rec = getAgent(payload.id, db);
      return rec ? { ok: true, data: rec } : { ok: false, error: `no agent record for "${payload.id}"` };
    },

    "agent:list": async (rawPayload: unknown): Promise<CommandResult<"agent:list">> => {
      const payload = rawPayload as Commands["agent:list"]["payload"];
      return { ok: true, data: { agents: listAgents({ ...(payload.repo !== undefined && { repo: payload.repo }) }, db) } };
    },
  };
}
