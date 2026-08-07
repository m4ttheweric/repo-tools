/**
 * Client-side plumbing for `rt validate` — the local door to the mattcloud
 * validation farm (see .local-dev/2026-08-07-validation-farm-design.md).
 *
 * Everything here is unit-testable with injected fetch/exec fakes. The
 * controller/receiver do not exist on a reachable host yet, so pieces that
 * can only be proven against the cluster carry a "cluster-verify pending"
 * note. Endpoints come from env with port-forward-shaped defaults:
 *
 *   MC_CONTROLLER_URL  (default http://localhost:8080)
 *   MC_RECEIVER_URL    (default ssh://git@localhost:2222)
 */

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { reposDir } from "./rt-paths.ts";
import { stripJsonc } from "./jsonc.ts";

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
    let raw: string;
    try {
      raw = readFileSync(join(reposRoot, entry, "repo.jsonc"), "utf8");
    } catch {
      continue; // no repo.jsonc in this overlay dir
    }
    try {
      const parsed = JSON.parse(stripJsonc(raw)) as { origin?: string };
      if (parsed.origin && normalizeOrigin(parsed.origin) === want) return entry;
    } catch {
      continue; // malformed overlay file — skip, never throw
    }
  }
  return null;
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
