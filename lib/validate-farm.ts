/**
 * Client-side plumbing for `rt validate` — the local door to the mattcloud
 * validation farm (see .local-dev/2026-08-07-validation-farm-design.md).
 *
 * Everything here is unit-testable with injected fetch/exec fakes. The
 * controller/receiver do not exist on a reachable host yet, so pieces that
 * can only be proven against the cluster carry a "cluster-verify pending"
 * note. Endpoints come from env with port-forward-shaped defaults:
 *
 *   MC_CONTROLLER_URL    (default http://localhost:8080)
 *   MC_RECEIVER_URL      (default ssh://git@localhost:2222)
 *   MC_RECEIVER_SSH_KEY  (optional: private key path pinned for the receiver
 *                         push — the operator's default identity lives in an
 *                         ssh agent, so the in-cluster receiver needs an
 *                         explicit knob for deterministic key selection)
 */

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { reposDir } from "./rt-paths.ts";
import { stripJsonc } from "./jsonc.ts";
import { getRemoteDefaultBranch } from "./git-ops.ts";
import { SnapshotBaseRefError } from "./snapshot.ts";

// ─── Endpoints ───────────────────────────────────────────────────────────────

export function controllerUrl(): string {
  return (process.env.MC_CONTROLLER_URL ?? "http://localhost:8080").replace(/\/$/, "");
}

export function receiverUrl(): string {
  return (process.env.MC_RECEIVER_URL ?? "ssh://git@localhost:2222").replace(/\/$/, "");
}

/** The receiver's bare-repo push URL for a repoId (Task 2 path convention). */
export function receiverRepoUrl(repoId: string): string {
  return `${receiverUrl()}/repos/${repoId}.git`;
}

/**
 * Extra env for the receiver push: when MC_RECEIVER_SSH_KEY names a private
 * key, pin ssh to exactly that key; otherwise leave ssh's own resolution
 * (agent, config) alone.
 */
export function receiverSshEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const key = env.MC_RECEIVER_SSH_KEY;
  if (!key) return {};
  return {
    GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };
}

/** Injected git-push runner so the push is unit-testable off-cluster. */
export type GitPushSpawn = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<{ exitCode: number; stderr: string }>;

const spawnGitPush: GitPushSpawn = async (argv, opts) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
};

/**
 * Push the snapshot commit to the receiver as refs/snapshots/<tree>
 * (incremental — the mirror already has master's objects; no local ref is
 * created). Cluster-verify pending: the real spawn leg needs a live receiver.
 */
export async function pushSnapshot(opts: {
  repoId: string;
  commit: string;
  tree: string;
  cwd: string;
  spawn?: GitPushSpawn;
  env?: Record<string, string | undefined>;
}): Promise<{ ok: boolean; pushUrl: string; stderr: string }> {
  const spawn = opts.spawn ?? spawnGitPush;
  const pushUrl = receiverRepoUrl(opts.repoId);
  const result = await spawn(
    // Forced refspec: snapshot refs are content-addressed by tree, so any
    // commit carrying the tree is equivalent; non-fast-forward retries must win.
    ["git", "push", pushUrl, `+${opts.commit}:refs/snapshots/${opts.tree}`],
    { cwd: opts.cwd, env: receiverSshEnv(opts.env ?? process.env) },
  );
  return { ok: result.exitCode === 0, pushUrl, stderr: result.stderr };
}

// ─── repoId resolution ───────────────────────────────────────────────────────

/**
 * Normalize a git origin URL so ssh/https spellings of the same repo compare
 * equal: `git@gitlab.com:a/b.git` and `https://gitlab.com/a/b` both become
 * `gitlab.com/a/b`.
 */
export function normalizeOrigin(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\//, "")
    .replace(/^git:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
}

/** Overlay repo.jsonc shape rt reads (schema is otherwise the farm's business). */
export interface RepoOverlay {
  origin?: string;
  defaultBranch?: string;
}

/** Read an overlay's repo.jsonc; null when missing or malformed, never throws. */
export function readRepoOverlay(repoId: string, reposRoot: string = reposDir()): RepoOverlay | null {
  try {
    const raw = readFileSync(join(reposRoot, repoId, "repo.jsonc"), "utf8");
    return JSON.parse(stripJsonc(raw)) as RepoOverlay;
  } catch {
    return null;
  }
}

/**
 * Resolve the farm repoId for a worktree's origin URL: the overlay directory
 * name under ~/.rt/repos/ whose repo.jsonc `origin` matches. Returns null
 * when no overlay claims the origin (the repo is not farm-enabled).
 */
export function resolveRepoId(originUrl: string, reposRoot: string = reposDir()): string | null {
  const want = normalizeOrigin(originUrl);
  let entries: string[];
  try {
    entries = readdirSync(reposRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const overlay = readRepoOverlay(entry, reposRoot);
    if (overlay?.origin && normalizeOrigin(overlay.origin) === want) return entry;
  }
  return null;
}

/**
 * The base ref snapshots diff against: the overlay's declared `defaultBranch`
 * when present, else whichever of origin/main / origin/master exists in the
 * worktree, else origin/master. Always returned in full refs/remotes form so
 * a local branch named "origin/x" can never shadow it.
 */
export function resolveBaseRef(repoId: string, cwd: string, reposRoot: string = reposDir()): string {
  const declared = readRepoOverlay(repoId, reposRoot)?.defaultBranch;
  if (declared) return `refs/remotes/origin/${declared}`;
  const detected = getRemoteDefaultBranch(cwd);
  if (detected) return `refs/remotes/${detected}`;
  return "refs/remotes/origin/master";
}

// ─── Gate manifest (client side) ─────────────────────────────────────────────

/**
 * Parsed loosely on purpose: schema validation is the controller's job
 * (mattcloud Task 5). rt only needs the JSONC → JSON conversion, the
 * secretRef for secrets sync, and a stable hash.
 */
export interface GateManifest {
  image: string;
  env?: Record<string, string>;
  secretRef?: string;
  taskGroups: Array<{ name: string; run: string; when?: string; services?: string[] }>;
}

export function loadGateManifest(path: string): GateManifest {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(stripJsonc(raw)) as GateManifest;
}

/** Recursively sort object keys so JSON.stringify is content-stable. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Stable sha256 of the canonical-JSON manifest. Cluster-verify pending:
 * must produce the same hash as the controller's manifestHash (mattcloud
 * Task 5) — reconcile in Task 10 calibration.
 */
export function manifestHash(manifest: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(manifest))).digest("hex");
}

// ─── Controller HTTP client ──────────────────────────────────────────────────

// Mirrors mattcloud controller/src/types.ts (Task 4).
export interface GroupResult {
  name: string;
  status: "pass" | "fail" | "skipped" | "inherited" | "infra";
  logRef?: string;
}

export interface Run {
  id: string;
  repoId: string;
  tree: string;
  manifestHash: string;
  status: "pending" | "running" | "done" | "infra";
  groups: GroupResult[];
  createdAt: string;
}

export interface SubmitRequest {
  repoId: string;
  tree: string;
  manifestHash: string;
  manifest: GateManifest;
  changedFiles: string[];
  mergeBase: string;
  /**
   * Always create a fresh run: the controller skips the verdict-cache AND
   * the in-flight attach and responds `cached: false`. Omitted entirely when
   * not forcing. Cluster-verify pending: the controller side is a sibling
   * contract, asserted here only as request shape.
   */
  force?: true;
}

export interface ControllerClient {
  submit(req: SubmitRequest): Promise<{ runId: string; cached: boolean }>;
  getRun(id: string): Promise<Run | null>;
  getGroupLog(id: string, group: string): Promise<string | null>;
}

/**
 * Thin client over the Task 4/6 HTTP API. Cluster-verify pending: shapes
 * are asserted against the plan, not a live controller.
 */
export function createControllerClient(
  baseUrl: string = controllerUrl(),
  fetchFn: typeof fetch = fetch,
): ControllerClient {
  return {
    async submit(req) {
      const res = await fetchFn(`${baseUrl}/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`controller POST /validate failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { runId: string; cached: boolean };
    },
    async getRun(id) {
      const res = await fetchFn(`${baseUrl}/runs/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`controller GET /runs/${id} failed: ${res.status}`);
      return (await res.json()) as Run;
    },
    async getGroupLog(id, group) {
      const res = await fetchFn(`${baseUrl}/runs/${id}/logs/${group}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`controller GET /runs/${id}/logs/${group} failed: ${res.status}`);
      return await res.text();
    },
  };
}

// ─── Verdict mapping ─────────────────────────────────────────────────────────

/**
 * Exit-code contract: 0 farm-green (inherited-only failures included, per
 * the Task 7 baseline semantics) / 1 red / 2 infra.
 */
export function verdictExitCode(run: Run): 0 | 1 | 2 {
  if (run.status === "infra") return 2;
  if (run.groups.some(g => g.status === "infra")) return 2;
  if (run.groups.some(g => g.status === "fail")) return 1;
  return 0;
}

/**
 * Exit code for `rt validate status`: 64 run-not-found (usage — a bad or
 * stale id, not a farm problem), 3 still in flight (documented — distinct
 * from both farm-green 0 and red 1), else the verdict contract.
 */
export function statusExitCode(run: Run | null): 0 | 1 | 2 | 3 | 64 {
  if (!run) return 64;
  if (run.status === "pending" || run.status === "running") return 3;
  return verdictExitCode(run);
}

/**
 * Map a pipeline failure to the exit-code contract: a missing base ref is
 * the user's setup (64); everything else — controller HTTP, poll, git
 * plumbing — is infra (2). Never 1: a farm-side failure must not read as a
 * red code verdict.
 */
export function failureExitCode(err: unknown): 2 | 64 {
  return err instanceof SnapshotBaseRefError ? 64 : 2;
}

/** One summary line in farm language (never "CI-green"). */
export function summarizeRun(run: Run): string {
  const counts = new Map<string, number>();
  for (const g of run.groups) counts.set(g.status, (counts.get(g.status) ?? 0) + 1);
  const parts = [...counts.entries()].map(([status, n]) => `${n} ${status}`).join(", ");
  if (run.status === "infra" || run.groups.some(g => g.status === "infra")) {
    return `farm-infra — not a code verdict (${parts})`;
  }
  if (run.groups.some(g => g.status === "fail")) return `farm-red (${parts})`;
  if (run.groups.some(g => g.status === "inherited")) return `farm-green with inherited failures (${parts})`;
  if (run.status !== "done") return `${run.status} (${parts})`;
  return `farm-green (${parts})`;
}

// ─── Endpoint readiness (port-forward) ───────────────────────────────────────

export interface EnsureEndpointsDeps {
  /** True when the controller answers /healthz. */
  probe: () => Promise<boolean>;
  /** Spawn `kubectl port-forward` for controller + receiver; returns a stop handle. */
  spawnForwards: () => { stop: () => void };
  delayMs?: (ms: number) => Promise<void>;
}

export interface EndpointsHandle {
  status: "already-up" | "forwarded" | "unreachable";
  stop: () => void;
}

/**
 * Make the controller reachable: no-op when something (the daemon, a manual
 * port-forward, a non-localhost MC_CONTROLLER_URL) already answers, else
 * spawn kubectl port-forwards for the command's lifetime and wait for
 * readiness. Cluster-verify pending: the spawn path can only be proven
 * against a live cluster.
 */
export async function ensureEndpoints(deps: EnsureEndpointsDeps): Promise<EndpointsHandle> {
  const delay = deps.delayMs ?? (ms => new Promise(r => setTimeout(r, ms)));
  if (await deps.probe()) return { status: "already-up", stop: () => {} };
  const forwards = deps.spawnForwards();
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(500);
    if (await deps.probe()) return { status: "forwarded", stop: forwards.stop };
  }
  forwards.stop();
  return { status: "unreachable", stop: () => {} };
}
