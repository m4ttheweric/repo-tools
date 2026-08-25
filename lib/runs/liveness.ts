/**
 * Liveness evidence for the stale predicate (attention.ts). A run whose DB is
 * silent can still be actively driven — the agent works for an hour inside
 * one stage and writes nothing until the boundary — so before calling it
 * stale we look for two out-of-band signals, each one the reader can check:
 *
 *  - a herdr agent currently `working` whose cwd sits inside the run's
 *    worktree (`herdr agent list`), and
 *  - recent filesystem activity in the worktree's git dir (commits, index
 *    writes, checkouts).
 *
 * Both probes degrade to "no evidence" on any failure: herdr missing, socket
 * down, worktree deleted. Absence of evidence keeps the silence measurement
 * in charge, exactly as before this module existed.
 */
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { runCapture } from "../subprocess.ts";
import type { RunLiveness } from "./attention.ts";

const HERDR_TIMEOUT_MS = 1500;
const AGENT_CACHE_TTL_MS = 10_000;

interface HerdrAgent {
  agent_status?: string;
  cwd?: string;
  foreground_cwd?: string;
  pane_id?: string;
  agent_session?: { value?: string };
}

export interface WorkingAgents {
  /** agent cwd and foreground cwd of every `working` agent → pane id. */
  byCwd: Map<string, string>;
  /** claude session id of every `working` agent → pane id. */
  bySession: Map<string, string>;
}

const NO_AGENTS: WorkingAgents = { byCwd: new Map(), bySession: new Map() };

export async function probeWorkingAgents(
  exec: typeof runCapture = runCapture,
): Promise<WorkingAgents> {
  // The daemon's launchd PATH may not carry ~/.local/bin, so resolve the
  // binary explicitly; a machine with no herdr at all fails the spawn and
  // runCapture reports exitCode -1, which reads as "no evidence" below.
  const bin = Bun.which("herdr") ?? join(homedir(), ".local", "bin", "herdr");
  const res = await exec([bin, "agent", "list"], { timeoutMs: HERDR_TIMEOUT_MS });
  if (res.exitCode !== 0) return NO_AGENTS;
  try {
    const parsed = JSON.parse(res.stdout) as { result?: { agents?: HerdrAgent[] } };
    const out: WorkingAgents = { byCwd: new Map(), bySession: new Map() };
    for (const a of parsed.result?.agents ?? []) {
      if (a.agent_status !== "working" || !a.pane_id) continue;
      for (const cwd of [a.cwd, a.foreground_cwd]) {
        if (cwd) out.byCwd.set(cwd, a.pane_id);
      }
      if (a.agent_session?.value) out.bySession.set(a.agent_session.value, a.pane_id);
    }
    return out;
  } catch {
    return NO_AGENTS;
  }
}

function cwdInside(cwd: string, worktree: string): boolean {
  return cwd === worktree || cwd.startsWith(worktree.endsWith("/") ? worktree : worktree + "/");
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

let agentCache: { at: number; agents: WorkingAgents } | null = null;

/** Test seam: forget the herdr result between cases. */
export function resetLivenessCache(): void {
  agentCache = null;
}

/**
 * One liveness snapshot for a whole runs:list/runs:get request. The herdr
 * probe is cached briefly so the console's per-tab polling doesn't spawn a
 * subprocess per request; the worktree stat runs fresh per run (it's a few
 * statSync calls on local disk).
 */
export async function getRunLiveness(
  exec: typeof runCapture = runCapture,
  now: number = Date.now(),
): Promise<RunLiveness> {
  if (!agentCache || now - agentCache.at > AGENT_CACHE_TTL_MS) {
    agentCache = { at: now, agents: await probeWorkingAgents(exec) };
  }
  const agents = agentCache.agents;
  return {
    workingSessionPane(sessionId: string): string | null {
      return agents.bySession.get(sessionId) ?? null;
    },
    workingAgentPane(worktree: string): string | null {
      for (const [cwd, pane] of agents.byCwd) {
        if (cwdInside(cwd, worktree)) return pane;
      }
      return null;
    },
    worktreeActiveAt: worktreeActivityAt,
  };
}
