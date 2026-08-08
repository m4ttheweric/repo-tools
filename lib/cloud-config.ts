/**
 * `rt cloud sync-config` — upsert the repo overlay's config files into
 * cluster ConfigMaps. Sibling of lib/cloud-secrets.ts and the same
 * kubectl-stdin pattern: file bytes flow memory → kubectl create
 * --dry-run -o yaml (stdin) → kubectl apply (stdin); nothing is written
 * to disk along the way.
 *
 * ConfigMaps (namespace mc-system):
 *   repo-gates            key gates.jsonc     (required — the gate manifest)
 *   repo-bake-config      key bake.jsonc      (optional — image-bake config)
 *   repo-sandbox-config   key <repoId>.json   (optional — sandbox.jsonc, comments
 *                         stripped: the controller mounts the ConfigMap at
 *                         /config-sandbox and JSON.parses <repoId>.json)
 *   repo-evidence-config  key evidence.jsonc  (optional: evidence-capture
 *                         overlay; mounted at /config-evidence for the bake job)
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

/** apply an in-memory multi-key ConfigMap manifest via stdin; null on success. */
async function applyConfigMapManifest(
  exec: Exec,
  namespace: string,
  name: string,
  data: Record<string, string>,
): Promise<string | null> {
  const apply = await exec(["kubectl", "-n", namespace, "apply", "-f", "-"], {
    stdin: JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name, namespace },
      data,
    }),
  });
  if (apply.exitCode !== 0) {
    return `kubectl apply failed for ConfigMap ${name} — is the cluster reachable?`;
  }
  return null;
}

/**
 * Upsert the overlay's config files into their ConfigMaps: gates.jsonc →
 * repo-gates (required), bake.jsonc → repo-bake-config,
 * sandbox-bake.jsonc → sandbox-bake-config, sandbox.jsonc →
 * repo-sandbox-config (keyed <repoId>.json — the caller converts JSONC to
 * JSON since the controller JSON.parses it), evidence.jsonc →
 * repo-evidence-config, and browser-flows/* → repo-browser-flows (one key
 * per flow file, applied as one in-memory manifest since kubectl's stdin
 * carries only one file). Null/absent optional inputs are legal — the
 * outcome message says what was skipped.
 */
export async function syncConfig(opts: {
  gates: string;
  bake: string | null;
  sandboxBake?: string | null;
  /** sandbox.jsonc already stripped to plain JSON, keyed by repoId. */
  sandbox?: { repoId: string; json: string } | null;
  evidence?: string | null;
  browserFlows?: Array<{ name: string; content: string }> | null;
  namespace?: string;
  exec?: Exec;
}): Promise<ConfigSyncOutcome> {
  const exec = opts.exec ?? spawnExec;
  const namespace = opts.namespace ?? "mc-system";
  const synced: string[] = [];
  const skipped: string[] = [];

  const gatesError = await upsertConfigMap(exec, namespace, "repo-gates", "gates.jsonc", opts.gates);
  if (gatesError) return { exitCode: 1, message: gatesError };
  synced.push("repo-gates");

  if (opts.bake === null) {
    skipped.push("repo-bake-config skipped (no bake.jsonc in the overlay)");
  } else {
    const bakeError = await upsertConfigMap(exec, namespace, "repo-bake-config", "bake.jsonc", opts.bake);
    if (bakeError) return { exitCode: 1, message: bakeError };
    synced.push("repo-bake-config");
  }

  if (opts.sandboxBake === null || opts.sandboxBake === undefined) {
    skipped.push("sandbox-bake-config skipped (no sandbox-bake.jsonc in the overlay)");
  } else {
    const error = await upsertConfigMap(exec, namespace, "sandbox-bake-config", "sandbox-bake.jsonc", opts.sandboxBake);
    if (error) return { exitCode: 1, message: error };
    synced.push("sandbox-bake-config");
  }

  if (opts.sandbox === null || opts.sandbox === undefined) {
    skipped.push("repo-sandbox-config skipped (no sandbox.jsonc in the overlay)");
  } else {
    const error = await upsertConfigMap(
      exec, namespace, "repo-sandbox-config", `${opts.sandbox.repoId}.json`, opts.sandbox.json,
    );
    if (error) return { exitCode: 1, message: error };
    synced.push("repo-sandbox-config");
  }

  if (opts.evidence === null || opts.evidence === undefined) {
    skipped.push("repo-evidence-config skipped (no evidence.jsonc in the overlay)");
  } else {
    const error = await upsertConfigMap(exec, namespace, "repo-evidence-config", "evidence.jsonc", opts.evidence);
    if (error) return { exitCode: 1, message: error };
    synced.push("repo-evidence-config");
  }

  if (!opts.browserFlows || opts.browserFlows.length === 0) {
    skipped.push("repo-browser-flows skipped (no browser-flows/ in the overlay)");
  } else {
    const data: Record<string, string> = {};
    for (const flow of opts.browserFlows) data[flow.name] = flow.content;
    const error = await applyConfigMapManifest(exec, namespace, "repo-browser-flows", data);
    if (error) return { exitCode: 1, message: error };
    synced.push("repo-browser-flows");
  }

  return {
    exitCode: 0,
    message: `synced ${synced.join(", ")} (${namespace})${skipped.length ? ` — ${skipped.join("; ")}` : ""}`,
  };
}
