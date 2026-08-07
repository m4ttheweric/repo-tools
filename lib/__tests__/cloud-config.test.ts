import { describe, expect, test } from "bun:test";

import { syncConfig } from "../cloud-config.ts";
import type { Exec, ExecResult } from "../cloud-secrets.ts";

interface Call {
  argv: string[];
  stdin?: string;
}

/** Fake exec that scripts responses per leading argv words and records calls. */
function fakeExec(script: Record<string, ExecResult>): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (argv, opts = {}) => {
    calls.push({ argv: [...argv], stdin: opts.stdin });
    for (const [prefix, result] of Object.entries(script)) {
      if (argv.join(" ").startsWith(prefix)) return result;
    }
    return { stdout: "", exitCode: 127 };
  };
  return { exec, calls };
}

const GATES = `{\n  // gate manifest\n  "image": "img",\n  "taskGroups": [],\n}\n`;
const BAKE = `{ "dockerfile": "ci/Dockerfile", "installCmd": "bun install" }\n`;
const GATES_YAML = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: repo-gates\n";
const BAKE_YAML = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: repo-bake-config\n";

describe("syncConfig", () => {
  test("upserts both ConfigMaps via kubectl stdin — exact argv, dry-run yaml routed to apply", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system create configmap repo-gates": { stdout: GATES_YAML, exitCode: 0 },
      "kubectl -n mc-system create configmap repo-bake-config": { stdout: BAKE_YAML, exitCode: 0 },
      "kubectl -n mc-system apply": { stdout: "configured\n", exitCode: 0 },
    });

    const out = await syncConfig({ gates: GATES, bake: BAKE, exec });

    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("repo-gates");
    expect(out.message).toContain("repo-bake-config");

    expect(calls.map(c => c.argv)).toEqual([
      [
        "kubectl", "-n", "mc-system", "create", "configmap", "repo-gates",
        "--from-file=gates.jsonc=/dev/stdin", "--dry-run=client", "-o", "yaml",
      ],
      ["kubectl", "-n", "mc-system", "apply", "-f", "-"],
      [
        "kubectl", "-n", "mc-system", "create", "configmap", "repo-bake-config",
        "--from-file=bake.jsonc=/dev/stdin", "--dry-run=client", "-o", "yaml",
      ],
      ["kubectl", "-n", "mc-system", "apply", "-f", "-"],
    ]);
    // File bytes go to the dry-run's stdin; the yaml it emits goes to apply's.
    expect(calls[0]!.stdin).toBe(GATES);
    expect(calls[1]!.stdin).toBe(GATES_YAML);
    expect(calls[2]!.stdin).toBe(BAKE);
    expect(calls[3]!.stdin).toBe(BAKE_YAML);
  });

  test("missing bake.jsonc syncs gates alone and says so", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system create configmap repo-gates": { stdout: GATES_YAML, exitCode: 0 },
      "kubectl -n mc-system apply": { stdout: "configured\n", exitCode: 0 },
    });

    const out = await syncConfig({ gates: GATES, bake: null, exec });

    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("no bake.jsonc");
    expect(out.message).toContain("repo-bake-config skipped");
    expect(calls.some(c => c.argv.includes("repo-bake-config"))).toBe(false);
  });

  test("fails with 1 when the dry-run create fails, naming the ConfigMap", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system create configmap repo-gates": { stdout: "", exitCode: 1 },
    });
    const out = await syncConfig({ gates: GATES, bake: BAKE, exec });
    expect(out.exitCode).toBe(1);
    expect(out.message).toContain("repo-gates");
    expect(calls).toHaveLength(1); // no apply, no bake attempt
  });

  test("fails with 1 when apply fails, without attempting the bake sync", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system create configmap repo-gates": { stdout: GATES_YAML, exitCode: 0 },
      "kubectl -n mc-system apply": { stdout: "", exitCode: 1 },
    });
    const out = await syncConfig({ gates: GATES, bake: BAKE, exec });
    expect(out.exitCode).toBe(1);
    expect(out.message).toContain("apply failed");
    expect(calls.some(c => c.argv.includes("repo-bake-config"))).toBe(false);
  });

  test("namespace override reaches every kubectl call", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n other create configmap repo-gates": { stdout: GATES_YAML, exitCode: 0 },
      "kubectl -n other apply": { stdout: "configured\n", exitCode: 0 },
    });
    const out = await syncConfig({ gates: GATES, bake: null, namespace: "other", exec });
    expect(out.exitCode).toBe(0);
    expect(calls.every(c => c.argv[2] === "other")).toBe(true);
  });
});

// ─── Sandbox extensions (slice 2): sandbox-bake-config + repo-browser-flows ──

describe("syncConfig sandbox extensions", () => {
  const SANDBOX_BAKE = `{ "agentCliVersion": "2.1.0", "fastBrowserVersion": "0.9.1" }\n`;
  const SANDBOX_BAKE_YAML = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: sandbox-bake-config\n";

  test("sandbox-bake.jsonc syncs to ConfigMap sandbox-bake-config via the same stdin pattern", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system create configmap repo-gates": { stdout: GATES_YAML, exitCode: 0 },
      "kubectl -n mc-system create configmap sandbox-bake-config": { stdout: SANDBOX_BAKE_YAML, exitCode: 0 },
      "kubectl -n mc-system apply": { stdout: "configured\n", exitCode: 0 },
    });
    const out = await syncConfig({ gates: GATES, bake: null, sandboxBake: SANDBOX_BAKE, exec });
    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("sandbox-bake-config");
    const create = calls.find(c => c.argv.includes("sandbox-bake-config"))!;
    expect(create.argv).toContain("--from-file=sandbox-bake.jsonc=/dev/stdin");
    expect(create.stdin).toBe(SANDBOX_BAKE);
  });

  test("browser flows sync as one multi-key ConfigMap applied from an in-memory manifest", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system create configmap repo-gates": { stdout: GATES_YAML, exitCode: 0 },
      "kubectl -n mc-system apply": { stdout: "configured\n", exitCode: 0 },
    });
    const out = await syncConfig({
      gates: GATES,
      bake: null,
      browserFlows: [
        { name: "login.flow.md", content: "# login" },
        { name: "evidence.flow.md", content: "# evidence" },
      ],
      exec,
    });
    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("repo-browser-flows");
    const apply = calls.filter(c => c.argv.join(" ") === "kubectl -n mc-system apply -f -")
      .find(c => c.stdin!.includes("repo-browser-flows"))!;
    const manifest = JSON.parse(apply.stdin!);
    expect(manifest.kind).toBe("ConfigMap");
    expect(manifest.metadata.name).toBe("repo-browser-flows");
    expect(manifest.data).toEqual({ "login.flow.md": "# login", "evidence.flow.md": "# evidence" });
  });

  test("absent sandbox overlay files are skipped and said so, without kubectl calls for them", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-system create configmap repo-gates": { stdout: GATES_YAML, exitCode: 0 },
      "kubectl -n mc-system apply": { stdout: "configured\n", exitCode: 0 },
    });
    const out = await syncConfig({ gates: GATES, bake: null, exec });
    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("repo-bake-config skipped");
    expect(calls.some(c => c.argv.includes("sandbox-bake-config"))).toBe(false);
    expect(calls.some(c => (c.stdin ?? "").includes("repo-browser-flows"))).toBe(false);
  });
});
