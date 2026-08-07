/**
 * `rt cloud secrets sync` — pipe a doppler env snapshot into a cluster
 * Secret without the env contents ever touching disk. The snapshot flows
 * doppler → memory → kubectl stdin; nothing here may write it to a file,
 * and log/error messages must never include env contents (counts only).
 *
 * Refuses (exit 64) when `doppler` on PATH is the mattcloud in-pod shim:
 * the shim only replays a mounted snapshot, so "syncing" through it would
 * upload stale values while looking authoritative.
 */

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

/** Injected process runner — `stdin` is written to the child, never to disk. */
export type Exec = (
  argv: [string, ...string[]],
  opts?: { cwd?: string; stdin?: string },
) => Promise<ExecResult>;

/** Real Exec: Bun.spawn with stdin piped from memory. */
export const spawnExec: Exec = async (argv, opts = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { stdout: "", exitCode: -1 };
  }
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
};

/** The one shim check: `doppler --version` output names the mattcloud shim. */
function versionNamesShim(stdout: string): boolean {
  return stdout.toLowerCase().includes("mattcloud");
}

/** Detect the mattcloud doppler shim (its --version output names it). */
export async function isDopplerShim(exec: Exec): Promise<boolean> {
  const r = await exec(["doppler", "--version"]);
  return r.exitCode === 0 && versionNamesShim(r.stdout);
}

export interface SecretsSyncOutcome {
  /** 0 ok, 1 tooling/download failure, 64 refused (shim or missing secretRef). */
  exitCode: 0 | 1 | 64;
  message: string;
}

/**
 * doppler secrets download (in-memory) → kubectl create secret --dry-run
 * -o yaml → kubectl apply, all via stdin. Cluster-verify pending: the
 * kubectl leg can only be integration-verified against the cluster.
 */
export async function syncSecrets(opts: {
  cwd: string;
  secretRef: string | undefined;
  namespace?: string;
  exec?: Exec;
}): Promise<SecretsSyncOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? "mc-validate";

  if (!opts.secretRef) {
    return { exitCode: 64, message: "gate manifest has no secretRef — nothing to sync" };
  }

  const version = await exec(["doppler", "--version"]);
  if (version.exitCode !== 0) {
    return { exitCode: 1, message: "doppler not found on PATH — install it or fix PATH" };
  }
  if (versionNamesShim(version.stdout)) {
    return { exitCode: 64, message: "refusing: `doppler` on PATH is the mattcloud shim, not the real CLI" };
  }

  const download = await exec(
    ["doppler", "secrets", "download", "--no-file", "--format", "env"],
    { cwd: opts.cwd },
  );
  if (download.exitCode !== 0) {
    return { exitCode: 1, message: "doppler secrets download failed — check `doppler setup` in this worktree" };
  }
  const varCount = download.stdout.split("\n").filter(l => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).length;
  if (varCount === 0) {
    return { exitCode: 1, message: "doppler returned no env vars — refusing to upsert an empty Secret" };
  }

  const dryRun = await exec(
    [
      "kubectl", "-n", namespace, "create", "secret", "generic", opts.secretRef,
      "--from-env-file=/dev/stdin", "--dry-run=client", "-o", "yaml",
    ],
    { stdin: download.stdout },
  );
  if (dryRun.exitCode !== 0) {
    return { exitCode: 1, message: "kubectl create --dry-run failed — is kubectl on PATH with the mattcloud context?" };
  }

  const apply = await exec(["kubectl", "-n", namespace, "apply", "-f", "-"], { stdin: dryRun.stdout });
  if (apply.exitCode !== 0) {
    return { exitCode: 1, message: "kubectl apply failed — is the cluster reachable?" };
  }

  return {
    exitCode: 0,
    message: `synced ${varCount} env vars into Secret ${opts.secretRef} (${namespace})`,
  };
}

// ─── Sandbox extensions (slice 2) ────────────────────────────────────────────
// Same posture as syncSecrets: values flow memory → kubectl stdin, never
// argv and never a new disk location; messages carry names/counts only.

export interface SandboxSecretOutcome {
  /** 0 ok, 1 tooling failure, 64 refused (nothing to upsert). */
  exitCode: 0 | 1 | 64;
  message: string;
}

/** apply an in-memory Secret manifest via kubectl stdin; null on success. */
async function applySecretManifest(
  exec: Exec,
  namespace: string,
  name: string,
  fields: { stringData?: Record<string, string>; data?: Record<string, string> },
): Promise<string | null> {
  const apply = await exec(["kubectl", "-n", namespace, "apply", "-f", "-"], {
    stdin: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace },
      type: "Opaque",
      ...fields,
    }),
  });
  if (apply.exitCode !== 0) {
    return `kubectl apply failed for Secret ${name} — is the cluster reachable?`;
  }
  return null;
}

/**
 * Upsert `repo-browser-secrets` — the dotenv fast-browser stat-checks at
 * /secrets/browser/env. Whose login these are is the operator's choice
 * (design ruling); rt only moves the bytes. Cluster-verify pending.
 */
export async function syncBrowserSecrets(opts: {
  content: string;
  namespace?: string;
  exec?: Exec;
}): Promise<SandboxSecretOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? "mc-sandboxes";
  if (!opts.content.trim()) {
    return { exitCode: 64, message: "browser secrets file is empty — refusing to upsert an empty Secret" };
  }
  const error = await applySecretManifest(exec, namespace, "repo-browser-secrets", {
    stringData: { env: opts.content },
  });
  if (error) return { exitCode: 1, message: error };
  return { exitCode: 0, message: `upserted Secret repo-browser-secrets (${namespace})` };
}

/**
 * Upsert `agent-credentials` — opaque files at overlay-named keys, mounted
 * at overlay-named $HOME paths by the controller. The contract is generic
 * on purpose: HOW the operator produces the files is adapter business, and
 * nothing here knows or cares (design ruling 1). Binary-safe (base64
 * `data`). Cluster-verify pending.
 */
export async function syncAgentCredentials(opts: {
  files: Record<string, Uint8Array>;
  namespace?: string;
  exec?: Exec;
}): Promise<SandboxSecretOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? "mc-sandboxes";
  const entries = Object.entries(opts.files);
  if (entries.length === 0) {
    return { exitCode: 64, message: "no agent credential files — declare them in the overlay first" };
  }
  const data: Record<string, string> = {};
  for (const [key, bytes] of entries) {
    data[key] = Buffer.from(bytes).toString("base64");
  }
  const error = await applySecretManifest(exec, namespace, "agent-credentials", { data });
  if (error) return { exitCode: 1, message: error };
  return {
    exitCode: 0,
    message: `upserted Secret agent-credentials with ${entries.length} file${entries.length === 1 ? "" : "s"} (${namespace})`,
  };
}
