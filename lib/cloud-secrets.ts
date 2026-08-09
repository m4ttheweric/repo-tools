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

/**
 * Read an existing cluster object's `.data` for a read-modify-write merge
 * (MAT-226: shared multi-repo maps must never be replaced wholesale).
 * `--ignore-not-found` makes "absent" a clean success with empty stdout, so
 * a non-zero exit is a real tooling/cluster failure, never a first sync.
 */
export async function getClusterObjectData(
  exec: Exec,
  namespace: string,
  kind: "configmap" | "secret",
  name: string,
): Promise<{ ok: true; data: Record<string, string> } | { ok: false; message: string }> {
  const got = await exec(
    ["kubectl", "-n", namespace, "get", kind, name, "-o", "json", "--ignore-not-found"],
  );
  if (got.exitCode !== 0) {
    return { ok: false, message: `kubectl get failed for ${kind} ${name} — is the cluster reachable?` };
  }
  if (!got.stdout.trim()) return { ok: true, data: {} };
  try {
    const parsed = JSON.parse(got.stdout) as { data?: Record<string, string> };
    return { ok: true, data: parsed.data ?? {} };
  } catch {
    return { ok: false, message: `kubectl get returned unparseable JSON for ${kind} ${name}` };
  }
}

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
 * doppler secrets download (in-memory, JSON) → kubectl apply via stdin.
 * The Secret carries doppler's JSON export verbatim under the single key
 * `doppler.json`; the in-pod shim parses it back. JSON (not dotenv)
 * because multiline values break both `--from-env-file` and line-based
 * parsers. Cluster-verify pending: the kubectl leg can only be
 * integration-verified against the cluster.
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
    ["doppler", "secrets", "download", "--no-file", "--format", "json"],
    { cwd: opts.cwd },
  );
  if (download.exitCode !== 0) {
    return { exitCode: 1, message: "doppler secrets download failed — check `doppler setup` in this worktree" };
  }
  let varCount = 0;
  try {
    const parsed: unknown = JSON.parse(download.stdout);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exitCode: 1, message: "doppler download was not a JSON object; refusing to upsert" };
    }
    varCount = Object.keys(parsed).length;
  } catch {
    return { exitCode: 1, message: "doppler download was not valid JSON; refusing to upsert" };
  }
  if (varCount === 0) {
    return { exitCode: 1, message: "doppler returned no env vars — refusing to upsert an empty Secret" };
  }

  const error = await applySecretManifest(exec, namespace, opts.secretRef, {
    stringData: { "doppler.json": download.stdout },
  });
  if (error) return { exitCode: 1, message: error };

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
 * `data`). The Secret is shared across repos (overlay-named keys), so the
 * repo's keys MERGE into the existing data — replacing wholesale would
 * delete sibling repos' credentials (MAT-226). Cluster-verify pending.
 */
// ─── Attended lanes (MAT-235) ────────────────────────────────────────────────

/**
 * Upsert the `attended-ssh-key` Secret with the operator's public half under
 * key `pubkey` — the controller injects it as ATTENDED_AUTHORIZED_KEY into
 * attended pods. Single-operator Secret, so a wholesale replace is correct
 * (no MAT-226 merge dance). The private half never leaves ~/.rt/secrets.
 */
export async function syncAttendedSshKey(opts: {
  publicKey: string;
  namespace?: string;
  exec?: Exec;
}): Promise<SandboxSecretOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? "mc-sandboxes";
  if (!opts.publicKey.trim()) {
    return { exitCode: 64, message: "attended ssh public key is empty — refusing to upsert" };
  }
  const error = await applySecretManifest(exec, namespace, "attended-ssh-key", {
    stringData: { pubkey: opts.publicKey },
  });
  if (error) return { exitCode: 1, message: error };
  return { exitCode: 0, message: `upserted Secret attended-ssh-key (${namespace})` };
}

/**
 * 2100-01-01T00:00:00Z in ms. Setup-token access tokens don't expire on the
 * recipe's timescale; the TUI only checks expiresAt against Date.now(), so a
 * fixed far-future stamp keeps the minted file deterministic.
 */
export const TUI_CREDENTIALS_EXPIRES_AT_MS = 4102444800000;

export interface TuiAccountIdentity {
  email: string;
  organizationUuid: string;
  organizationName: string;
}

/**
 * MAT-233 provider seam: resolving WHO an account key is (email, org) is
 * adapter business — the cswap adapter implements this, rt core only takes
 * the answer and writes files. Nothing cswap-shaped may creep in here.
 */
export type TuiIdentityProvider = (accountKey: string) => Promise<TuiAccountIdentity>;

/**
 * The two files a TUI (attended) lane needs in the pod's $HOME, exactly per
 * the MAT-231 spike recipe: `.claude/.credentials.json` (claudeAiOauth from
 * setup-token) and `.claude.json` (onboarding done, identity block, and
 * /workspace/src pre-trusted). The env token is deliberately NOT part of
 * this: attended lanes must not see CLAUDE_CODE_OAUTH_TOKEN.
 */
export function mintTuiCredentialFiles(
  input: { token: string } & TuiAccountIdentity,
): { credentialsJson: string; claudeJson: string } {
  const credentialsJson = JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: input.token,
        refreshToken: null,
        expiresAt: TUI_CREDENTIALS_EXPIRES_AT_MS,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
      },
    },
    null,
    2,
  );
  const claudeJson = JSON.stringify(
    {
      hasCompletedOnboarding: true,
      theme: "dark",
      oauthAccount: {
        emailAddress: input.email,
        organizationUuid: input.organizationUuid,
        organizationName: input.organizationName,
        organizationRole: "admin",
      },
      projects: { "/workspace/src": { hasTrustDialogAccepted: true } },
    },
    null,
    2,
  );
  return { credentialsJson, claudeJson };
}

/**
 * Mint an account's two TUI files and merge-upsert them as agent-credentials
 * keys `<accountKey>.credentials.json` / `<accountKey>.claude.json` — the
 * keys the controller subPath-mounts into attended pods. Reuses the MAT-226
 * merge path so sibling accounts' and repos' keys survive.
 */
export async function syncTuiCredentials(opts: {
  accountKey: string;
  token: string;
  identity: TuiIdentityProvider;
  namespace?: string;
  exec?: Exec;
}): Promise<SandboxSecretOutcome> {
  if (!opts.token.trim()) {
    return { exitCode: 64, message: `no token for ${opts.accountKey} — refusing to mint empty TUI credentials` };
  }
  const identity = await opts.identity(opts.accountKey);
  const minted = mintTuiCredentialFiles({ token: opts.token, ...identity });
  const encoder = new TextEncoder();
  const out = await syncAgentCredentials({
    files: {
      [`${opts.accountKey}.credentials.json`]: encoder.encode(minted.credentialsJson),
      [`${opts.accountKey}.claude.json`]: encoder.encode(minted.claudeJson),
    },
    ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
    ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
  });
  if (out.exitCode !== 0) return out;
  return {
    exitCode: 0,
    message: `upserted TUI credentials for ${opts.accountKey} into Secret agent-credentials (${opts.namespace ?? "mc-sandboxes"})`,
  };
}

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
  const existing = await getClusterObjectData(exec, namespace, "secret", "agent-credentials");
  if (!existing.ok) return { exitCode: 1, message: existing.message };
  const data: Record<string, string> = { ...existing.data };
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
