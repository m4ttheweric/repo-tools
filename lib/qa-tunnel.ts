/**
 * The QA reverse tunnel (design ruling 2026-08-07): the operator's local SDM
 * session exposes the QA datasource on a local port; rt extends that reach
 * into the cluster with `ssh -R` through the receiver's existing sshd, so
 * the QA DB answers at receiver.mc-system.svc:<clusterPort> while the
 * tunnel is up. No SDM credential, token, or client ever enters the
 * cluster; the tunnel dies with the laptop session, and a mid-capture drop
 * surfaces as the backend's DB error, same as local.
 *
 * The pod learns about it via the flags-pattern env Secret
 * (`sandbox-<id>-env`, POSTGRES_URL override) and a pod recycle
 * (suspend + resume) applies it — mirroring the local "restart the
 * backend" rule.
 *
 * Unit-tested with injected probe/spawn/exec fakes; the ssh and kubectl
 * legs are cluster-verify pending (receiver sshd needs T2's
 * `AllowTcpForwarding remote`).
 */

import { receiverUrl } from "./validate-farm.ts";
import { SANDBOX_NAMESPACE, applyManifest, type SandboxOpOutcome } from "./sandbox.ts";
import { spawnExec, type Exec } from "./cloud-secrets.ts";

/** Where the tunnel surfaces in-cluster: the receiver's Service DNS name. */
export const QA_CLUSTER_HOST = "receiver.mc-system.svc";

/** Default in-cluster port the QA datasource is exposed on. */
export const QA_DEFAULT_CLUSTER_PORT = 15432;

// ─── Receiver ssh endpoint ───────────────────────────────────────────────────

export function parseReceiverSsh(url: string): { user: string; host: string; port: number } {
  const match = url.match(/^ssh:\/\/([^@]+)@([^:/]+)(?::(\d+))?/);
  if (!match) throw new Error(`unparseable receiver URL: ${url}`);
  return { user: match[1]!, host: match[2]!, port: match[3] ? Number(match[3]) : 22 };
}

// ─── Tunnel argv ─────────────────────────────────────────────────────────────

export function qaTunnelArgv(opts: {
  clusterPort: number;
  localPort: number;
  receiverUrl?: string;
  sshKey?: string;
}): string[] {
  const { user, host, port } = parseReceiverSsh(opts.receiverUrl ?? receiverUrl());
  return [
    "ssh",
    ...(opts.sshKey ? ["-i", opts.sshKey, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new"] : []),
    "-N",
    "-R", `${opts.clusterPort}:127.0.0.1:${opts.localPort}`,
    "-p", String(port),
    `${user}@${host}`,
  ];
}

// ─── POSTGRES_URL override ───────────────────────────────────────────────────

/**
 * The URL the in-pod backend should dial. The overlay may shape it
 * (`qaPostgresUrlTemplate` with {host}/{port} placeholders — credentials and
 * db name are adapter facts); the default is a bare postgres URL against the
 * receiver service.
 */
export function qaPostgresUrl(template: string | undefined, clusterPort: number): string {
  const t = template ?? "postgresql://{host}:{port}/postgres";
  return t.replaceAll("{host}", QA_CLUSTER_HOST).replaceAll("{port}", String(clusterPort));
}

/**
 * Upsert the per-sandbox env-override Secret (`sandbox-<id>-env`, dotenv
 * under key `env`) — the same envguard mechanism as the flags Secret, and
 * the same recycle rule: a pod recycle (suspend + resume) applies it.
 */
export async function upsertEnvSecret(opts: {
  sandboxId: string;
  env: Record<string, string>;
  namespace?: string;
  exec?: Exec;
}): Promise<SandboxOpOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? SANDBOX_NAMESPACE;
  const name = `sandbox-${opts.sandboxId}-env`;
  const dotenv = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const error = await applyManifest(exec, namespace, {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace },
    type: "Opaque",
    stringData: { env: dotenv },
  });
  if (error) return { exitCode: 1, message: `${error} (Secret ${name})` };
  return {
    exitCode: 0,
    message: `upserted Secret ${name} (${namespace}) — recycle the pod (suspend + resume) to apply`,
  };
}

// ─── Open ────────────────────────────────────────────────────────────────────

export interface TunnelHandle {
  kill(): void;
  exited: Promise<number>;
}

/** Injected ssh spawner so the tunnel is unit-testable off-cluster. */
export type TunnelSpawn = (argv: string[]) => TunnelHandle;

/** Real spawner. Cluster-verify pending. */
export const spawnTunnel: TunnelSpawn = (argv) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return {
    kill: () => {
      try { proc.kill(); } catch { /* already exited */ }
    },
    exited: proc.exited,
  };
};

/**
 * Preflight the local SDM listener, open the reverse tunnel, and inject the
 * POSTGRES_URL override. Refuses before spawning anything when the listener
 * is down (the credential stays local — there is nothing to fall back to).
 */
export async function openQaTunnel(opts: {
  sandboxId: string;
  localPort: number;
  clusterPort?: number;
  urlTemplate?: string;
  probeListener: (port: number) => Promise<boolean>;
  spawn: TunnelSpawn;
  exec: Exec;
  env?: Record<string, string | undefined>;
  onDeath?: (exitCode: number) => void;
}): Promise<
  | { ok: true; handle: TunnelHandle; postgresUrl: string; clusterPort: number }
  | { ok: false; message: string }
> {
  const clusterPort = opts.clusterPort ?? QA_DEFAULT_CLUSTER_PORT;
  const env = opts.env ?? process.env;

  if (!(await opts.probeListener(opts.localPort))) {
    return {
      ok: false,
      message: `nothing answers on 127.0.0.1:${opts.localPort} — is the sdm tunnel connected? (rt sdm)`,
    };
  }

  const handle = opts.spawn(qaTunnelArgv({
    clusterPort,
    localPort: opts.localPort,
    ...(env.MC_RECEIVER_URL ? { receiverUrl: env.MC_RECEIVER_URL } : {}),
    ...(env.MC_RECEIVER_SSH_KEY ? { sshKey: env.MC_RECEIVER_SSH_KEY } : {}),
  }));

  const postgresUrl = qaPostgresUrl(opts.urlTemplate, clusterPort);
  const secret = await upsertEnvSecret({
    sandboxId: opts.sandboxId,
    env: { POSTGRES_URL: postgresUrl },
    exec: opts.exec,
  });
  if (secret.exitCode !== 0) {
    handle.kill();
    return { ok: false, message: secret.message };
  }

  if (opts.onDeath) {
    void handle.exited.then(code => opts.onDeath!(code));
  }
  return { ok: true, handle, postgresUrl, clusterPort };
}
