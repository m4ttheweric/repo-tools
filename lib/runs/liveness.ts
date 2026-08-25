/**
 * Liveness evidence for the attention predicate (attention.ts), and the live
 * agent-status mirror on run summaries. A run whose DB is silent can still be
 * actively driven — the agent works for an hour inside one stage and writes
 * nothing until the boundary — so before calling it stale we look for
 * out-of-band signals, each one the reader can check:
 *
 *  - the herdr agent attributed to the run (`herdr agent list`, matched by
 *    recorded claude session, else by cwd inside the run's worktree), whose
 *    status is mirrored verbatim: working suppresses stale, blocked IS
 *    attention ("agent waiting for input");
 *  - recent filesystem activity in the worktree's git dir (commits, index
 *    writes, checkouts).
 *
 * herdr is OPTIONAL. Every probe failure — binary missing, socket down,
 * timeout, garbled output — degrades to "no evidence": no agent on the
 * payload, no blocked reason, staleness decided by the heartbeat rungs alone.
 * `probeAgents` distinguishes that failure (null) from a successful empty
 * answer ([]) so the status poller can hold last-known state through a herdr
 * restart instead of flapping every run to null and back.
 */
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import type { RunAgent } from "../../packages/rt-client/src/commands.ts";
import { runCapture } from "../subprocess.ts";
import type { RunLiveness } from "./attention.ts";

const HERDR_TIMEOUT_MS = 1500;
const AGENT_CACHE_TTL_MS = 10_000;

const STATUSES: ReadonlySet<string> = new Set(["working", "idle", "blocked", "done", "unknown"]);

export interface AgentEntry {
  status: RunAgent["status"];
  pane: string;
  session: string | null;
  cwds: string[];
}

interface HerdrAgent {
  agent_status?: string;
  cwd?: string;
  foreground_cwd?: string;
  pane_id?: string;
  agent_session?: { value?: string };
}

/** All herdr agents, every status. null = probe FAILED (herdr missing or
    unreachable); [] = herdr answered and no agents exist. */
export async function probeAgents(
  exec: typeof runCapture = runCapture,
): Promise<AgentEntry[] | null> {
  // The daemon's launchd PATH may not carry ~/.local/bin, so resolve the
  // binary explicitly; a machine with no herdr at all fails the spawn and
  // runCapture reports exitCode -1.
  const bin = Bun.which("herdr") ?? join(homedir(), ".local", "bin", "herdr");
  const res = await exec([bin, "agent", "list"], { timeoutMs: HERDR_TIMEOUT_MS });
  if (res.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { result?: { agents?: HerdrAgent[] } };
    const agents = parsed.result?.agents;
    if (!Array.isArray(agents)) return null;
    const out: AgentEntry[] = [];
    for (const a of agents) {
      if (!a.pane_id) continue;
      out.push({
        status: (STATUSES.has(a.agent_status ?? "") ? a.agent_status : "unknown") as RunAgent["status"],
        pane: a.pane_id,
        session: a.agent_session?.value ?? null,
        cwds: [a.cwd, a.foreground_cwd].filter((c): c is string => !!c),
      });
    }
    return out;
  } catch {
    return null;
  }
}

function cwdInside(cwd: string, worktree: string): boolean {
  return cwd === worktree || cwd.startsWith(worktree.endsWith("/") ? worktree : worktree + "/");
}

// When several agents sit in one worktree, the most actionable status wins.
const STATUS_PRIORITY: RunAgent["status"][] = ["blocked", "working", "idle", "done", "unknown"];

/** The pure matcher behind getRunLiveness — also used by the status poller,
    which brings its own probe result. */
export function livenessFrom(entries: AgentEntry[]): RunLiveness {
  const agentOf = (e: AgentEntry): RunAgent => ({ status: e.status, pane: e.pane });
  return {
    agentFor(session: string | null, worktree: string | null): RunAgent | null {
      if (session) {
        const hit = entries.find((e) => e.session === session);
        if (hit) return agentOf(hit);
      }
      if (worktree) {
        const hits = entries.filter((e) => e.cwds.some((c) => cwdInside(c, worktree)));
        for (const status of STATUS_PRIORITY) {
          const hit = hits.find((e) => e.status === status);
          if (hit) return agentOf(hit);
        }
      }
      return null;
    },
    workingSessionPane(sessionId: string): string | null {
      return entries.find((e) => e.status === "working" && e.session === sessionId)?.pane ?? null;
    },
    workingAgentPane(worktree: string): string | null {
      return (
        entries.find((e) => e.status === "working" && e.cwds.some((c) => cwdInside(c, worktree)))?.pane ?? null
      );
    },
    worktreeActiveAt: worktreeActivityAt,
  };
}

/**
 * Most recent mtime among the worktree's git-activity files, or null when
 * nothing is statable. A linked worktree's `.git` is a file naming its real
 * gitdir; HEAD and index there move on every commit, checkout, or stage.
 */
export function worktreeActivityAt(worktree: string): number | null {
  let latest: number | null = null;
  const bump = (path: string) => {
    try {
      const t = statSync(path).mtimeMs;
      if (latest == null || t > latest) latest = t;
    } catch {
      /* absent path is simply not evidence */
    }
  };
  try {
    const gitPath = join(worktree, ".git");
    let gitDir = gitPath;
    const st = statSync(gitPath);
    if (st.isFile()) {
      const pointer = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1];
      if (!pointer) return null;
      gitDir = isAbsolute(pointer) ? pointer : resolve(worktree, pointer);
    }
    bump(gitDir);
    bump(join(gitDir, "HEAD"));
    bump(join(gitDir, "index"));
  } catch {
    return null;
  }
  return latest;
}

let agentCache: { at: number; entries: AgentEntry[] } | null = null;

/** Test seam: forget the herdr result between cases. */
export function resetLivenessCache(): void {
  agentCache = null;
}

/** The status poller shares its fresher probe with request-path liveness. */
export function primeLivenessCache(entries: AgentEntry[], now: number = Date.now()): void {
  agentCache = { at: now, entries };
}

/**
 * One liveness snapshot for a whole runs:list/runs:get request. The herdr
 * probe is cached briefly so the console's per-tab polling doesn't spawn a
 * subprocess per request; the worktree stat runs fresh per run (it's a few
 * statSync calls on local disk). A failed probe degrades to no evidence for
 * this snapshot without overwriting a fresher poller-primed cache.
 */
export async function getRunLiveness(
  exec: typeof runCapture = runCapture,
  now: number = Date.now(),
): Promise<RunLiveness> {
  if (!agentCache || now - agentCache.at > AGENT_CACHE_TTL_MS) {
    agentCache = { at: now, entries: (await probeAgents(exec)) ?? [] };
  }
  return livenessFrom(agentCache.entries);
}
