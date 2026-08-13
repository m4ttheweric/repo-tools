/**
 * `rt db push` — the freshness AND recovery verb for the mattcloud cluster
 * database. Dumps the local `acme` database, restores it into the
 * cluster's `acme_tpl` template, then recreates the live `acme`
 * server-side from that template. Credentials are read from the cluster at
 * runtime and never persisted; every kubectl/pg_dump/psql leg goes through
 * the injected Exec seam so tests never touch a real local or cluster DB.
 */

import { kubectlEnv } from "./cloud-secrets.ts";
import { probeLocalListener } from "./sandbox-allocator.ts";
import { ensureEndpoints } from "./validate-farm.ts";

export const DB_NAMESPACE = "mc-system";
export const DB_SERVICE = "postgres";
export const DB_LOCAL_PORT = 15432;
export const DB_CLUSTER_PORT = 5432;
export const LIVE_DB = "acme";
export const TEMPLATE_DB = "acme_tpl";
export const CREDENTIALS_SECRET = "postgres-credentials";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injected process runner for every kubectl/pg_dump/psql leg. */
export type Exec = (
  argv: [string, ...string[]],
  opts?: { cwd?: string; stdin?: string; env?: Record<string, string | undefined> },
) => Promise<ExecResult>;

/** Real Exec: Bun.spawn with the mattcloud KUBECONFIG resolved at spawn time. */
export const spawnExec: Exec = async (argv, opts = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: { ...kubectlEnv(), ...(opts.env ?? {}) },
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { stdout: "", stderr: "failed to spawn", exitCode: -1 };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

/** Local `acme` database size in bytes, or null when the local query fails. */
export async function localDumpSizeBytes(exec: Exec): Promise<number | null> {
  const res = await exec(["psql", "-d", LIVE_DB, "-tAc", `SELECT pg_database_size('${LIVE_DB}');`]);
  if (res.exitCode !== 0) return null;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

/** Kills every other backend connected to `db` — precedes a DROP DATABASE. */
export function terminateConnectionsSql(db: string): string {
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`;
}

export function dropDatabaseSql(db: string): string {
  return `DROP DATABASE IF EXISTS "${db}";`;
}

export function createDatabaseSql(db: string, template?: string): string {
  return template ? `CREATE DATABASE "${db}" TEMPLATE "${template}";` : `CREATE DATABASE "${db}";`;
}

export interface PortForwardHandle {
  kill(): void;
  exited: Promise<number>;
}

/** Real spawner: `kubectl port-forward` to the cluster postgres Service. */
export const spawnPostgresForward = (): PortForwardHandle => {
  const proc = Bun.spawn(
    ["kubectl", "-n", DB_NAMESPACE, "port-forward", `svc/${DB_SERVICE}`, `${DB_LOCAL_PORT}:${DB_CLUSTER_PORT}`],
    { env: kubectlEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  return {
    kill: () => {
      try { proc.kill(); } catch { /* already exited */ }
    },
    exited: proc.exited,
  };
};

export interface PushConfirmSummary {
  cluster: string;
  sourceDb: string;
  dumpSizeBytes: number | null;
}

export type PushResult =
  | { ok: true; message: string }
  | { ok: false; code: "declined" | "unreachable" | "tooling" | "cluster"; message: string };

/**
 * Dump local `acme` → restore into cluster `acme_tpl` → recreate live
 * `acme` from the template, server-side. Every step past the confirm
 * prompt is destructive; declining touches nothing.
 */
export async function pushDatabase(opts: {
  exec: Exec;
  spawnForward: () => PortForwardHandle;
  probe?: () => Promise<boolean>;
  confirm: (summary: PushConfirmSummary) => Promise<boolean>;
  onPhase?: (phase: string, elapsedMs: number) => void;
  delayMs?: (ms: number) => Promise<void>;
}): Promise<PushResult> {
  const dumpSizeBytes = await localDumpSizeBytes(opts.exec);
  const proceed = await opts.confirm({
    cluster: `mattcloud cluster (${DB_NAMESPACE}/svc/${DB_SERVICE})`,
    sourceDb: `local ${LIVE_DB}`,
    dumpSizeBytes,
  });
  if (!proceed) {
    return { ok: false, code: "declined", message: "push cancelled — nothing was touched" };
  }

  const credsResult = await readClusterCredentials(opts.exec);
  if (!credsResult.ok) {
    return { ok: false, code: "unreachable", message: credsResult.message };
  }

  const probe = opts.probe ?? (() => probeLocalListener(DB_LOCAL_PORT));
  const endpoints = await ensureEndpoints({
    probe,
    spawnForwards: () => {
      const handle = opts.spawnForward();
      return { stop: () => handle.kill() };
    },
    ...(opts.delayMs ? { delayMs: opts.delayMs } : {}),
  });
  if (endpoints.status === "unreachable") {
    return {
      ok: false,
      code: "unreachable",
      message: `postgres unreachable at 127.0.0.1:${DB_LOCAL_PORT} — is the mattcloud cluster up and KUBECONFIG pointed at it?`,
    };
  }

  const creds = credsResult.creds;
  const onPhase = opts.onPhase ?? (() => {});
  const runPhase = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    const result = await fn();
    onPhase(phase, Date.now() - start);
    return result;
  };

  try {
    const dump = await runPhase("pg_dump local acme", () =>
      opts.exec(["pg_dump", "--no-owner", "--no-privileges", LIVE_DB]),
    );
    if (dump.exitCode !== 0) {
      return { ok: false, code: "tooling", message: `pg_dump failed: ${dump.stderr.trim() || "unknown error"}` };
    }

    const restoreTpl = await runPhase(`recreate ${TEMPLATE_DB} from the dump`, () =>
      recreateDatabase(opts.exec, creds, TEMPLATE_DB, { restoreFromStdin: dump.stdout }),
    );
    if (!restoreTpl.ok) {
      return { ok: false, code: "cluster", message: `restore into ${TEMPLATE_DB} failed: ${restoreTpl.message}` };
    }

    const recreateLive = await runPhase(`recreate live ${LIVE_DB} from ${TEMPLATE_DB}`, () =>
      recreateDatabase(opts.exec, creds, LIVE_DB, { template: TEMPLATE_DB }),
    );
    if (!recreateLive.ok) {
      return {
        ok: false,
        code: "cluster",
        message:
          `recreate of live ${LIVE_DB} failed: ${recreateLive.message} ` +
          `Recovery: ${TEMPLATE_DB} still holds the fresh dump — re-run \`rt db push\` or restore by hand with ` +
          `CREATE DATABASE ${LIVE_DB} TEMPLATE ${TEMPLATE_DB}.`,
      };
    }

    return {
      ok: true,
      message:
        `pushed local ${LIVE_DB} → ${TEMPLATE_DB} → live ${LIVE_DB} on the mattcloud cluster. ` +
        `Recovery: if ${LIVE_DB} is ever trashed, re-run \`rt db push\`, or restore the last pushed snapshot ` +
        `without a new dump via CREATE DATABASE ${LIVE_DB} TEMPLATE ${TEMPLATE_DB}.`,
    };
  } finally {
    endpoints.stop();
  }
}

/** One admin psql leg against `postgres`, PGPASSWORD via env, never argv. */
async function runAdminSql(
  exec: Exec,
  creds: ClusterCredentials,
  database: string,
  sql: string,
): Promise<ExecResult> {
  return exec(
    ["psql", "-h", "127.0.0.1", "-p", String(DB_LOCAL_PORT), "-U", creds.username, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", sql],
    { env: { PGPASSWORD: creds.password } },
  );
}

/**
 * Terminate connections, drop, and recreate `db` — either from a dump piped
 * over stdin, or (server-side, no dump involved) from a template database.
 */
async function recreateDatabase(
  exec: Exec,
  creds: ClusterCredentials,
  db: string,
  from: { restoreFromStdin: string } | { template: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const terminate = await runAdminSql(exec, creds, "postgres", terminateConnectionsSql(db));
  if (terminate.exitCode !== 0) return { ok: false, message: terminate.stderr.trim() || "terminate connections failed" };

  const drop = await runAdminSql(exec, creds, "postgres", dropDatabaseSql(db));
  if (drop.exitCode !== 0) return { ok: false, message: drop.stderr.trim() || "drop database failed" };

  if ("template" in from) {
    const create = await runAdminSql(exec, creds, "postgres", createDatabaseSql(db, from.template));
    if (create.exitCode !== 0) return { ok: false, message: create.stderr.trim() || "create database failed" };
    return { ok: true };
  }

  const create = await runAdminSql(exec, creds, "postgres", createDatabaseSql(db));
  if (create.exitCode !== 0) return { ok: false, message: create.stderr.trim() || "create database failed" };

  const restore = await exec(
    ["psql", "-h", "127.0.0.1", "-p", String(DB_LOCAL_PORT), "-U", creds.username, "-d", db, "-v", "ON_ERROR_STOP=1"],
    { stdin: from.restoreFromStdin, env: { PGPASSWORD: creds.password } },
  );
  if (restore.exitCode !== 0) return { ok: false, message: restore.stderr.trim() || "restore failed" };
  return { ok: true };
}

export interface ClusterCredentials {
  username: string;
  password: string;
}

/** Read the `postgres-credentials` Secret and base64-decode username/password. */
export async function readClusterCredentials(
  exec: Exec,
): Promise<{ ok: true; creds: ClusterCredentials } | { ok: false; message: string }> {
  const got = await exec(["kubectl", "-n", DB_NAMESPACE, "get", "secret", CREDENTIALS_SECRET, "-o", "json"]);
  if (got.exitCode !== 0) {
    return {
      ok: false,
      message: `kubectl get secret ${CREDENTIALS_SECRET} failed — is the mattcloud cluster reachable? (KUBECONFIG=$HOME/.rt/kubeconfig-mattcloud.yaml)`,
    };
  }
  let parsed: { data?: Record<string, string> };
  try {
    parsed = JSON.parse(got.stdout);
  } catch {
    return { ok: false, message: `kubectl get secret ${CREDENTIALS_SECRET} returned unparseable JSON` };
  }
  const usernameB64 = parsed.data?.username;
  const passwordB64 = parsed.data?.password;
  if (!usernameB64 || !passwordB64) {
    return { ok: false, message: `Secret ${CREDENTIALS_SECRET} is missing username/password keys` };
  }
  return {
    ok: true,
    creds: {
      username: Buffer.from(usernameB64, "base64").toString("utf8"),
      password: Buffer.from(passwordB64, "base64").toString("utf8"),
    },
  };
}
