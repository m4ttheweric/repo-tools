/**
 * Client-side plumbing for `rt sandbox` — the local door to mattcloud
 * sandboxes (see .local-dev/2026-08-07-sandbox-controller-design.md).
 *
 * Sibling of lib/validate-farm.ts and the same posture: everything here is
 * unit-testable with injected fetch/exec/spawn fakes, and every piece that
 * can only be proven against the cluster carries a "cluster-verify pending"
 * note. The controller's sandbox half (mattcloud Task 4) does not exist yet;
 * shapes are asserted against the design's API contract, not a live server.
 *
 * CONTRACT NOTES for the controller half (T4 must match; single sources of
 * truth are the helpers below, so a divergence is a one-line fix here):
 *  - Branch handshake: `rt sandbox create` pushes the branch head to
 *    `refs/sandboxes/incoming/<branch>` BEFORE POST /sandboxes (the
 *    pre-receive policy only admits refs/snapshots/* and refs/sandboxes/*,
 *    and the sandbox id does not exist until the POST returns). The seed Job
 *    fetches that ref; the controller prunes it after seeding.
 *  - Pod name == sandbox id (the design writes `pod/<sandbox>`).
 *  - GET list/events/mailbox return bare JSON arrays; POST mailbox takes one
 *    `{name, content}` file.
 *  - `captured` event payload is `{file, content}` with the file's text.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { reposDir, sandboxAnchorDir, sandboxesDir } from "./rt-paths.ts";
import { controllerUrl, receiverRepoUrl, receiverSshEnv, type GitPushSpawn } from "./validate-farm.ts";
import { spawnExec, type Exec } from "./cloud-secrets.ts";

/** The sandbox namespace — every sandbox-scoped cluster object lives here. */
export const SANDBOX_NAMESPACE = "mc-sandboxes";

// ─── Record types (mirror the design's sandbox model) ────────────────────────

export type SandboxState = "creating" | "running" | "suspended" | "destroyed" | "error";

export interface SandboxRecord {
  id: string;
  repoId: string;
  branch: string;
  imageTag: string;
  state: SandboxState;
  createdAt: string;
  /** Pod-side ports keyed by overlay process name. */
  ports: Record<string, number>;
  briefRef?: string;
  lastEventSeq: number;
}

export interface ContainerReadiness {
  name: string;
  ready: boolean;
}

/** GET detail: the record plus pod phase + per-container readiness. */
export interface SandboxDetail extends SandboxRecord {
  podPhase?: string;
  containers?: ContainerReadiness[];
}

export type SandboxEventType =
  | "question"
  | "report"
  | "blocked"
  | "process-dead"
  | "state"
  | "captured";

export interface SandboxEvent {
  seq: number;
  ts: string;
  sandboxId: string;
  type: SandboxEventType;
  payload: unknown;
}

export interface MailboxFile {
  name: string;
  content: string;
}

export interface CreateSandboxRequest {
  repoId: string;
  branch: string;
  imageTag?: string;
  brief: string;
  flagsFileContent?: string;
}

// ─── Controller HTTP client (sandbox half) ───────────────────────────────────

export interface SandboxClient {
  create(req: CreateSandboxRequest): Promise<{ sandboxId: string }>;
  list(): Promise<SandboxDetail[]>;
  get(id: string): Promise<SandboxDetail | null>;
  suspend(id: string): Promise<void>;
  /** `resume` is the same verb — the controller ensures the pod exists. */
  up(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  events(id: string, since: number): Promise<SandboxEvent[]>;
  mailbox(id: string): Promise<MailboxFile[]>;
  postMailbox(id: string, file: MailboxFile): Promise<void>;
}

/**
 * Thin client over the controller's sandbox API. Cluster-verify pending:
 * shapes are asserted against the design contract, not a live controller.
 */
export function createSandboxClient(
  baseUrl: string = controllerUrl(),
  fetchFn: typeof fetch = fetch,
): SandboxClient {
  async function requireOk(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new Error(`controller ${what} failed: ${res.status} ${await res.text()}`);
    return res;
  }
  return {
    async create(req) {
      const res = await fetchFn(`${baseUrl}/sandboxes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      await requireOk(res, "POST /sandboxes");
      return (await res.json()) as { sandboxId: string };
    },
    async list() {
      const res = await requireOk(await fetchFn(`${baseUrl}/sandboxes`), "GET /sandboxes");
      return (await res.json()) as SandboxDetail[];
    },
    async get(id) {
      const res = await fetchFn(`${baseUrl}/sandboxes/${id}`);
      if (res.status === 404) return null;
      await requireOk(res, `GET /sandboxes/${id}`);
      return (await res.json()) as SandboxDetail;
    },
    async suspend(id) {
      await requireOk(
        await fetchFn(`${baseUrl}/sandboxes/${id}/suspend`, { method: "POST" }),
        `POST /sandboxes/${id}/suspend`,
      );
    },
    async up(id) {
      await requireOk(
        await fetchFn(`${baseUrl}/sandboxes/${id}/up`, { method: "POST" }),
        `POST /sandboxes/${id}/up`,
      );
    },
    async destroy(id) {
      await requireOk(
        await fetchFn(`${baseUrl}/sandboxes/${id}`, { method: "DELETE" }),
        `DELETE /sandboxes/${id}`,
      );
    },
    async events(id, since) {
      const res = await requireOk(
        await fetchFn(`${baseUrl}/sandboxes/${id}/events?since=${since}`),
        `GET /sandboxes/${id}/events`,
      );
      return (await res.json()) as SandboxEvent[];
    },
    async mailbox(id) {
      const res = await requireOk(
        await fetchFn(`${baseUrl}/sandboxes/${id}/mailbox`),
        `GET /sandboxes/${id}/mailbox`,
      );
      return (await res.json()) as MailboxFile[];
    },
    async postMailbox(id, file) {
      await requireOk(
        await fetchFn(`${baseUrl}/sandboxes/${id}/mailbox`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(file),
        }),
        `POST /sandboxes/${id}/mailbox`,
      );
    },
  };
}

// ─── Overlay sandbox config ──────────────────────────────────────────────────

/**
 * One dev process the sandbox pod runs, from the overlay's config.json
 * `sandbox` section. `localPorts` is the ordered list of LOCAL candidate
 * ports the allocator may forward this process to (the Auth0-registered pool
 * for browser-facing processes — an adapter fact the overlay owns). When the
 * overlay omits it, the only candidate is the pod port itself: no silently
 * invented ports (an unregistered local port cannot complete Auth0 login, so
 * it would be a lying success).
 */
export interface SandboxProcess {
  name: string;
  port: number;
  startScript?: string;
  localPorts: number[];
}

export interface SandboxOverlayConfig {
  processes: SandboxProcess[];
  /** Local dev-ports state file the daemon mirrors into (absolute, ~ expanded). */
  stateFile?: string;
}

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  return join(process.env.HOME ?? homedir(), path.slice(1));
}

/**
 * Read the overlay's sandbox section from ~/.rt/repos/<repoId>/config.json.
 * Null when the overlay or the section is missing — the repo is not
 * sandbox-enabled. Parsed loosely on purpose (the controller owns schema
 * validation of its own copy); rt only needs process names/ports, the local
 * port pools, and the state-file path.
 */
export function readSandboxConfig(
  repoId: string,
  reposRoot: string = reposDir(),
): SandboxOverlayConfig | null {
  let raw: { sandbox?: { processes?: Array<Partial<SandboxProcess>>; stateFile?: string } };
  try {
    raw = JSON.parse(readFileSync(join(reposRoot, repoId, "config.json"), "utf8"));
  } catch {
    return null;
  }
  const sandbox = raw.sandbox;
  if (!sandbox || !Array.isArray(sandbox.processes)) return null;
  const processes: SandboxProcess[] = [];
  for (const p of sandbox.processes) {
    if (typeof p.name !== "string" || typeof p.port !== "number") return null;
    processes.push({
      name: p.name,
      port: p.port,
      ...(p.startScript !== undefined ? { startScript: p.startScript } : {}),
      localPorts: Array.isArray(p.localPorts) && p.localPorts.length > 0 ? p.localPorts : [p.port],
    });
  }
  return {
    processes,
    ...(sandbox.stateFile ? { stateFile: expandHome(sandbox.stateFile) } : {}),
  };
}

/** Every overlay under reposRoot that declares a sandbox section. */
export function listSandboxOverlays(
  reposRoot: string = reposDir(),
): Array<{ repoId: string; config: SandboxOverlayConfig }> {
  let entries: string[];
  try {
    entries = readdirSync(reposRoot);
  } catch {
    return [];
  }
  const out: Array<{ repoId: string; config: SandboxOverlayConfig }> = [];
  for (const repoId of entries) {
    const config = readSandboxConfig(repoId, reposRoot);
    if (config) out.push({ repoId, config });
  }
  return out;
}

// ─── Local anchor directory ──────────────────────────────────────────────────

/**
 * sandbox.json inside the anchor dir. The anchor dir path itself is the key
 * skills use in the dev-ports state file, so it must exist as a real
 * directory for the sandbox's lifetime.
 */
export interface SandboxAnchor {
  id: string;
  repoId: string;
  branch: string;
  createdAt: string;
  /** Last controller event seq the daemon has fanned out. */
  lastEventSeq: number;
  /** Local port allocation while running (released on suspend, kept as preference). */
  localPorts?: Record<string, number>;
  /** Loud `rt sandbox status` warning when the pool could not satisfy a process. */
  allocationError?: string;
}

export function writeSandboxAnchor(anchor: SandboxAnchor): void {
  const dir = sandboxAnchorDir(anchor.repoId, anchor.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sandbox.json"), JSON.stringify(anchor, null, 2));
}

export function readSandboxAnchor(repoId: string, sandboxId: string): SandboxAnchor | null {
  try {
    return JSON.parse(
      readFileSync(join(sandboxAnchorDir(repoId, sandboxId), "sandbox.json"), "utf8"),
    ) as SandboxAnchor;
  } catch {
    return null;
  }
}

/** Anchor ids on disk for a repoId (empty when none). */
export function listSandboxAnchors(repoId: string): SandboxAnchor[] {
  const dir = join(sandboxesDir(), repoId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SandboxAnchor[] = [];
  for (const id of entries) {
    const anchor = readSandboxAnchor(repoId, id);
    if (anchor) out.push(anchor);
  }
  return out;
}

export function removeSandboxAnchor(repoId: string, sandboxId: string): void {
  const dir = sandboxAnchorDir(repoId, sandboxId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Locate a sandbox's anchor without knowing its repoId (id-based verbs). */
export function findSandboxAnchor(sandboxId: string): SandboxAnchor | null {
  let repoIds: string[];
  try {
    repoIds = readdirSync(sandboxesDir());
  } catch {
    return null;
  }
  for (const repoId of repoIds) {
    const anchor = readSandboxAnchor(repoId, sandboxId);
    if (anchor) return anchor;
  }
  return null;
}

// ─── Branch handshake push ───────────────────────────────────────────────────

/** The pre-POST handshake ref the seed Job fetches (see CONTRACT NOTES). */
export function sandboxIncomingRef(branch: string): string {
  return `refs/sandboxes/incoming/${branch}`;
}

/**
 * Push the branch head to the receiver so the seed Job can fetch it — the
 * same plumbing as pushSnapshot (forced refspec, pinned ssh key env).
 * Cluster-verify pending: the real spawn leg needs a live receiver.
 */
export async function pushSandboxBranch(opts: {
  repoId: string;
  branch: string;
  commit: string;
  cwd: string;
  spawn: GitPushSpawn;
  env?: Record<string, string | undefined>;
}): Promise<{ ok: boolean; pushUrl: string; stderr: string }> {
  const pushUrl = receiverRepoUrl(opts.repoId);
  const result = await opts.spawn(
    ["git", "push", pushUrl, `+${opts.commit}:${sandboxIncomingRef(opts.branch)}`],
    { cwd: opts.cwd, env: receiverSshEnv(opts.env ?? process.env) },
  );
  return { ok: result.exitCode === 0, pushUrl, stderr: result.stderr };
}

// ─── Create flow ─────────────────────────────────────────────────────────────

/**
 * The create pipeline: handshake-push the branch head to the receiver
 * FIRST (the seed Job fetches it the moment the POST lands), then POST
 * /sandboxes, then write the local anchor the daemon and skills key on.
 */
export async function createSandboxFlow(opts: {
  repoId: string;
  branch: string;
  commit: string;
  cwd: string;
  brief: string;
  imageTag?: string;
  flags?: Record<string, unknown>;
  client: SandboxClient;
  spawn: GitPushSpawn;
  env?: Record<string, string | undefined>;
}): Promise<{ ok: true; sandboxId: string } | { ok: false; message: string }> {
  const push = await pushSandboxBranch({
    repoId: opts.repoId,
    branch: opts.branch,
    commit: opts.commit,
    cwd: opts.cwd,
    spawn: opts.spawn,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (!push.ok) {
    return { ok: false, message: `branch push to ${push.pushUrl} failed: ${push.stderr.trim()}` };
  }
  const { sandboxId } = await opts.client.create({
    repoId: opts.repoId,
    branch: opts.branch,
    brief: opts.brief,
    ...(opts.imageTag ? { imageTag: opts.imageTag } : {}),
    ...(opts.flags ? { flagsFileContent: JSON.stringify(opts.flags, null, 2) } : {}),
  });
  writeSandboxAnchor({
    id: sandboxId,
    repoId: opts.repoId,
    branch: opts.branch,
    createdAt: new Date().toISOString(),
    lastEventSeq: 0,
  });
  return { ok: true, sandboxId };
}

// ─── Logs passthrough ────────────────────────────────────────────────────────

/** kubectl logs argv for a sandbox container (pod name == sandbox id). */
export function sandboxLogsArgv(sandboxId: string, container: string, extra: string[] = []): string[] {
  return ["kubectl", "-n", SANDBOX_NAMESPACE, "logs", sandboxId, "-c", container, ...extra];
}

// ─── Flags ───────────────────────────────────────────────────────────────────

/**
 * Parse `k=v` pairs into a flags object. Values are JSON when they parse as
 * JSON (true/false/numbers/objects), else plain strings — same intent as the
 * local shim's fallback-file generator.
 */
export function parseFlagValues(pairs: string[]): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`malformed flag "${pair}" — expected k=v`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      flags[key] = JSON.parse(raw);
    } catch {
      flags[key] = raw;
    }
  }
  return flags;
}

export interface SandboxOpOutcome {
  /** 0 ok, 1 tooling failure. */
  exitCode: 0 | 1;
  message: string;
}

/**
 * Apply an in-memory k8s manifest via `kubectl apply -f -` (stdin). The
 * manifest never touches disk — same posture as lib/cloud-secrets.ts.
 */
export async function applyManifest(
  exec: Exec,
  namespace: string,
  manifest: object,
): Promise<string | null> {
  const apply = await exec(["kubectl", "-n", namespace, "apply", "-f", "-"], {
    stdin: JSON.stringify(manifest),
  });
  if (apply.exitCode !== 0) {
    return "kubectl apply failed — is the cluster reachable?";
  }
  return null;
}

/**
 * Upsert the per-sandbox LD fallback file Secret (`sandbox-<id>-flags`).
 * The same caveat as local: the fallback file REPLACES LaunchDarkly, so
 * unlisted flags fall to code defaults, and a change needs a pod recycle
 * (suspend + resume). Cluster-verify pending (kubectl leg).
 */
export async function upsertFlagsSecret(opts: {
  sandboxId: string;
  flags: Record<string, unknown>;
  namespace?: string;
  exec?: Exec;
}): Promise<SandboxOpOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? SANDBOX_NAMESPACE;
  const name = `sandbox-${opts.sandboxId}-flags`;
  const error = await applyManifest(exec, namespace, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace },
    type: "Opaque",
    stringData: { "flags.json": JSON.stringify(opts.flags, null, 2) },
  });
  if (error) return { exitCode: 1, message: `${error} (Secret ${name})` };
  return {
    exitCode: 0,
    message: `upserted Secret ${name} (${namespace}) — recycle the pod (suspend + resume) to apply`,
  };
}
