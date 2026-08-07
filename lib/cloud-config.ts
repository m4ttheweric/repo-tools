/**
 * `rt cloud sync-config` — upsert the repo overlay's config files into
 * cluster ConfigMaps. Sibling of lib/cloud-secrets.ts and the same
 * kubectl-stdin pattern: file bytes flow memory → kubectl create
 * --dry-run -o yaml (stdin) → kubectl apply (stdin); nothing is written
 * to disk along the way.
 *
 * ConfigMaps (namespace mc-system):
 *   repo-gates        key gates.jsonc   (required — the gate manifest)
 *   repo-bake-config  key bake.jsonc    (optional — image-bake config)
 *
 * The files are shipped as raw JSONC bytes; schema validation is the
 * controller's business (same "parsed loosely on purpose" stance as
 * lib/validate-farm.ts). Cluster-verify pending: the kubectl leg is
 * unit-tested with injected exec fakes only.
 */

import { spawnExec, type Exec } from "./cloud-secrets.ts";

export interface ConfigSyncOutcome {
  /** 0 ok, 1 tooling failure. (A missing gates.jsonc is the command's exit 64 — it never reaches here.) */
  exitCode: 0 | 1;
  message: string;
}

/** create --dry-run → apply, both via stdin; null on success, else the failure message. */
async function upsertConfigMap(
  exec: Exec,
  namespace: string,
  name: string,
  key: string,
  content: string,
): Promise<string | null> {
  const dryRun = await exec(
    [
      "kubectl", "-n", namespace, "create", "configmap", name,
      `--from-file=${key}=/dev/stdin`, "--dry-run=client", "-o", "yaml",
    ],
    { stdin: content },
  );
  if (dryRun.exitCode !== 0) {
    return `kubectl create --dry-run failed for ConfigMap ${name} — is kubectl on PATH with the mattcloud context?`;
  }
  const apply = await exec(["kubectl", "-n", namespace, "apply", "-f", "-"], { stdin: dryRun.stdout });
  if (apply.exitCode !== 0) {
    return `kubectl apply failed for ConfigMap ${name} — is the cluster reachable?`;
  }
  return null;
}

/**
 * Upsert gates.jsonc → repo-gates and (when present) bake.jsonc →
 * repo-bake-config. `bake` is null when the overlay has no bake.jsonc —
 * legal, and the outcome message says the bake sync was skipped.
 */
export async function syncConfig(opts: {
  gates: string;
  bake: string | null;
  namespace?: string;
  exec?: Exec;
}): Promise<ConfigSyncOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? "mc-system";

  const gatesError = await upsertConfigMap(exec, namespace, "repo-gates", "gates.jsonc", opts.gates);
  if (gatesError) return { exitCode: 1, message: gatesError };

  if (opts.bake === null) {
    return {
      exitCode: 0,
      message: `synced gates.jsonc → ConfigMap repo-gates (${namespace}) — no bake.jsonc in the overlay, repo-bake-config skipped`,
    };
  }

  const bakeError = await upsertConfigMap(exec, namespace, "repo-bake-config", "bake.jsonc", opts.bake);
  if (bakeError) return { exitCode: 1, message: bakeError };

  return {
    exitCode: 0,
    message: `synced gates.jsonc → ConfigMap repo-gates and bake.jsonc → ConfigMap repo-bake-config (${namespace})`,
  };
}
