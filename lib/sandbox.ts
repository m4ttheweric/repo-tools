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
 *  - Evidence: POST /sandboxes/:id/evidence {caseId,view,recipe,args?,slot,forceBefore?}
 *    -> {requestId}; GET list is a bare array (?state= filter); /evidence/:id/* verbs are
 *    claim (watcher), artifacts PUT/GET (raw bytes), complete, synced, DELETE (queued only).
 *    Events evidence-started/-ready/-failed carry {requestId}; -ready adds {summary, artifacts}.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { reposDir, sandboxAnchorDir, sandboxesDir } from "./rt-paths.ts";
import { controllerUrl, receiverRepoUrl, receiverSshEnv, receiverSshRemedy, type GitPushSpawn } from "./validate-farm.ts";
import { spawnExec, type Exec } from "./cloud-secrets.ts";
import { stripJsonc } from "./jsonc.ts";

/** The sandbox namespace — every sandbox-scoped cluster object lives here. */
export const SANDBOX_NAMESPACE = "mc-sandboxes";

// ─── Record types (mirror the design's sandbox model) ────────────────────────

export type SandboxState = "creating" | "running" | "suspended" | "destroyed" | "error";

export type EvidenceSlot = "before" | "after" | "standalone";
export type EvidenceState = "queued" | "running" | "captured" | "failed";

export interface EvidenceRequestRecord {
  id: string;
  sandboxId: string;
  caseId: string;
  view: string;
  recipe: string;
  args: Record<string, string>;
  slot: EvidenceSlot;
  state: EvidenceState;
  requestedBy: string;
  forceBefore: boolean;
  error: unknown | null;
  createdAt: string;
  updatedAt: string;
  syncedAt: string | null;
}

export interface EvidenceDetail extends EvidenceRequestRecord {
  artifacts: Array<{ name: string; size: number }>;
}

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
  | "captured"
  | "evidence-started"
  | "evidence-ready"
  | "evidence-failed";

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

export interface EvidenceBeforeEntry {
  caseId: string;
  view: string;
  recipe: string;
  args?: Record<string, string>;
}

export interface CreateSandboxRequest {
  repoId: string;
  branch: string;
  imageTag?: string;
  brief: string;
  flagsFileContent?: string;
  evidenceBefore?: EvidenceBeforeEntry[];
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
  requestEvidence(
    sandboxId: string,
    req: { caseId: string; view: string; recipe: string; args?: Record<string, string>; slot: EvidenceSlot; forceBefore?: boolean },
  ): Promise<{ requestId: string }>;
  listEvidence(sandboxId: string, state?: EvidenceState): Promise<EvidenceRequestRecord[]>;
  getEvidence(requestId: string): Promise<EvidenceDetail | null>;
  fetchEvidenceArtifact(requestId: string, name: string): Promise<Uint8Array>;
  cancelEvidence(requestId: string): Promise<void>;
  ackEvidenceSynced(requestId: string): Promise<void>;
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
    async requestEvidence(sandboxId, req) {
      const res = await fetchFn(`${baseUrl}/sandboxes/${sandboxId}/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
      await requireOk(res, `POST /sandboxes/${sandboxId}/evidence`);
      return (await res.json()) as { requestId: string };
    },
    async listEvidence(sandboxId, state) {
      const url = state ? `${baseUrl}/sandboxes/${sandboxId}/evidence?state=${state}` : `${baseUrl}/sandboxes/${sandboxId}/evidence`;
      const res = await requireOk(await fetchFn(url), `GET /sandboxes/${sandboxId}/evidence`);
      return (await res.json()) as EvidenceRequestRecord[];
    },
    async getEvidence(requestId) {
      const res = await fetchFn(`${baseUrl}/evidence/${requestId}`);
      if (res.status === 404) return null;
      await requireOk(res, `GET /evidence/${requestId}`);
      return (await res.json()) as EvidenceDetail;
    },
    async fetchEvidenceArtifact(requestId, name) {
      const res = await requireOk(
        await fetchFn(`${baseUrl}/evidence/${requestId}/artifacts/${name}`),
        `GET /evidence/${requestId}/artifacts/${name}`,
      );
      return new Uint8Array(await res.arrayBuffer());
    },
    async cancelEvidence(requestId) {
      await requireOk(
        await fetchFn(`${baseUrl}/evidence/${requestId}`, { method: "DELETE" }),
        `DELETE /evidence/${requestId}`,
      );
    },
    async ackEvidenceSynced(requestId) {
      await requireOk(
        await fetchFn(`${baseUrl}/evidence/${requestId}/synced`, { method: "POST" }),
        `POST /evidence/${requestId}/synced`,
      );
    },
  };
}

// ─── Overlay sandbox config ──────────────────────────────────────────────────

/**
 * One dev process the sandbox pod runs, from the overlay's sandbox.jsonc.
 * `localPorts` is the ordered list of LOCAL candidate
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
  /**
   * QA-tunnel POSTGRES_URL shape with {host}/{port} placeholders —
   * credentials and db name are adapter facts (lib/qa-tunnel.ts).
   */
  qaPostgresUrlTemplate?: string;
  /** Local dotenv for the repo-browser-secrets Secret (absolute, ~ expanded). */
  browserSecretsFile?: string;
  /**
   * agent-credentials sources: Secret key → local file path. The keys are
   * overlay-named; how the operator produces the files is adapter business
   * (design ruling 1 — nothing cswap-shaped in rt core).
   */
  agentCredentialFiles?: Record<string, string>;
}

function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  return join(process.env.HOME ?? homedir(), path.slice(1));
}

/**
 * Read the overlay's ~/.rt/repos/<repoId>/sandbox.jsonc — the canonical
 * per-repo sandbox config, same jsonc discipline as gates/bake/evidence
 * (JSONC bytes → stripJsonc → JSON.parse). Null when the file is missing or
 * malformed — the repo is not sandbox-enabled. Parsed loosely on purpose
 * (the controller owns schema validation of its own copy); rt only needs
 * process names/ports, the local port pools, and the state-file path.
 */
export function readSandboxConfig(
  repoId: string,
  reposRoot: string = reposDir(),
): SandboxOverlayConfig | null {
  let raw: unknown;
  try {
    const text = readFileSync(join(reposRoot, repoId, "sandbox.jsonc"), "utf8");
    raw = JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const sandbox = raw as {
    processes?: Array<Partial<SandboxProcess>>;
    stateFile?: string;
    qaPostgresUrlTemplate?: string;
    browserSecretsFile?: string;
    agentCredentialFiles?: Record<string, string>;
  };
  if (!Array.isArray(sandbox.processes)) return null;
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
    ...(sandbox.qaPostgresUrlTemplate ? { qaPostgresUrlTemplate: sandbox.qaPostgresUrlTemplate } : {}),
    ...(sandbox.browserSecretsFile ? { browserSecretsFile: expandHome(sandbox.browserSecretsFile) } : {}),
    ...(sandbox.agentCredentialFiles
      ? {
          agentCredentialFiles: Object.fromEntries(
            Object.entries(sandbox.agentCredentialFiles).map(([k, v]) => [k, expandHome(v)]),
          ),
        }
      : {}),
  };
}

/** Every overlay under reposRoot that ships a sandbox.jsonc. */
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
  reposRoot?: string;
}): Promise<{ ok: boolean; pushUrl: string; stderr: string }> {
  const pushUrl = receiverRepoUrl(opts.repoId);
  const result = await opts.spawn(
    ["git", "push", pushUrl, `+${opts.commit}:${sandboxIncomingRef(opts.branch)}`],
    { cwd: opts.cwd, env: receiverSshEnv(opts.env ?? process.env, opts.repoId, opts.reposRoot) },
  );
  return { ok: result.exitCode === 0, pushUrl, stderr: result.stderr };
}

// ─── Create flow ─────────────────────────────────────────────────────────────

/**
 * The create pipeline: resolve the named branch's head FIRST — explicitly as
 * refs/heads/<branch>, aborting before any push/POST/anchor when it does not
 * exist (MAT-216: a silent HEAD push seeded a sandbox from the wrong commit)
 * — then handshake-push it to the receiver (the seed Job fetches it the
 * moment the POST lands), then POST /sandboxes, then write the local anchor
 * the daemon and skills key on.
 */
export async function createSandboxFlow(opts: {
  repoId: string;
  branch: string;
  cwd: string;
  brief: string;
  imageTag?: string;
  flags?: Record<string, unknown>;
  evidenceBefore?: EvidenceBeforeEntry[];
  /**
   * Ref to seed from when refs/heads/<branch> is missing locally — the
   * --ticket path's "a fresh ticket branch is just the base ref's tree".
   * Absent means a missing branch aborts instead of falling back.
   */
  fallbackRef?: string;
  client: SandboxClient;
  spawn: GitPushSpawn;
  exec?: Exec;
  env?: Record<string, string | undefined>;
}): Promise<{ ok: true; sandboxId: string } | { ok: false; message: string }> {
  const exec = opts.exec ?? spawnExec;
  const resolve = async (ref: string): Promise<string | null> => {
    const r = await exec(["git", "rev-parse", "--verify", "--quiet", ref], { cwd: opts.cwd });
    const commit = r.stdout.trim();
    return r.exitCode === 0 && commit ? commit : null;
  };
  let commit = await resolve(`refs/heads/${opts.branch}`);
  if (!commit && opts.fallbackRef) commit = await resolve(opts.fallbackRef);
  if (!commit) {
    return {
      ok: false,
      message:
        `branch "${opts.branch}" does not exist in this checkout (refs/heads/${opts.branch}` +
        `${opts.fallbackRef ? ` and base ref ${opts.fallbackRef}` : ""} did not resolve) — nothing was pushed`,
    };
  }
  const push = await pushSandboxBranch({
    repoId: opts.repoId,
    branch: opts.branch,
    commit,
    cwd: opts.cwd,
    spawn: opts.spawn,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (!push.ok) {
    const remedy = receiverSshRemedy(push.stderr, { repoId: opts.repoId, url: push.pushUrl });
    return {
      ok: false,
      message: `branch push to ${push.pushUrl} failed: ${push.stderr.trim()}${remedy ? `\n${remedy}` : ""}`,
    };
  }
  const { sandboxId } = await opts.client.create({
    repoId: opts.repoId,
    branch: opts.branch,
    brief: opts.brief,
    ...(opts.imageTag ? { imageTag: opts.imageTag } : {}),
    ...(opts.flags ? { flagsFileContent: JSON.stringify(opts.flags, null, 2) } : {}),
    ...(opts.evidenceBefore?.length ? { evidenceBefore: opts.evidenceBefore } : {}),
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

/** Controller-side cap on CreateSandboxRequest.evidenceBefore entries. */
export const EVIDENCE_BEFORE_MAX = 10;

const EVIDENCE_BEFORE_FORM = "<caseId>:<view>:<recipe>[:k=v,...]";

/**
 * Parse repeated `--evidence-before` specs into CreateSandboxRequest.evidenceBefore.
 * Grammar: <caseId>:<view>:<recipe>[:k=v,...] — commas separate k=v pairs, and
 * colons after the third belong to the args segment (values may carry them).
 * Mirrors the controller's validation ({caseId,view,recipe,args?}, max 10) so
 * a bad spec dies client-side with the expected form named.
 */
export function parseEvidenceBeforeSpecs(specs: string[]): EvidenceBeforeEntry[] {
  if (specs.length > EVIDENCE_BEFORE_MAX) {
    throw new Error(`--evidence-before accepts at most ${EVIDENCE_BEFORE_MAX} entries (controller cap)`);
  }
  return specs.map((spec) => {
    const malformed = () =>
      new Error(`malformed --evidence-before "${spec}" — expected ${EVIDENCE_BEFORE_FORM}`);
    const [caseId, view, recipe, ...rest] = spec.split(":");
    if (!caseId || !view || !recipe) throw malformed();
    if (rest.length === 0) return { caseId, view, recipe };
    const argsSegment = rest.join(":");
    if (!argsSegment) throw malformed();
    const args: Record<string, string> = {};
    for (const pair of argsSegment.split(",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw malformed();
      args[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return { caseId, view, recipe, args };
  });
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
