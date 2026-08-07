import { describe, expect, test } from "bun:test";

import { isDopplerShim, syncSecrets, type Exec, type ExecResult } from "../cloud-secrets.ts";

interface Call {
  argv: string[];
  stdin?: string;
  cwd?: string;
}

/** Fake exec that scripts responses per leading argv words and records calls. */
function fakeExec(script: Record<string, ExecResult>): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (argv, opts = {}) => {
    calls.push({ argv: [...argv], stdin: opts.stdin, cwd: opts.cwd });
    for (const [prefix, result] of Object.entries(script)) {
      if (argv.join(" ").startsWith(prefix)) return result;
    }
    return { stdout: "", exitCode: 127 };
  };
  return { exec, calls };
}

const REAL_VERSION: ExecResult = { stdout: "v3.75.0\n", exitCode: 0 };
const SHIM_VERSION: ExecResult = { stdout: "mattcloud doppler shim v1\n", exitCode: 0 };
const ENV_SNAPSHOT: ExecResult = { stdout: "FOO=bar\nBAZ_URL=https://x\n", exitCode: 0 };

describe("isDopplerShim", () => {
  test("detects the mattcloud shim by its --version output", async () => {
    expect(await isDopplerShim(fakeExec({ "doppler --version": SHIM_VERSION }).exec)).toBe(true);
    expect(await isDopplerShim(fakeExec({ "doppler --version": REAL_VERSION }).exec)).toBe(false);
  });
});

describe("syncSecrets", () => {
  test("refuses the shim with exit 64 before downloading anything", async () => {
    const { exec, calls } = fakeExec({ "doppler --version": SHIM_VERSION });
    const out = await syncSecrets({ cwd: "/wt", secretRef: "acme-doppler-env", exec });
    expect(out.exitCode).toBe(64);
    expect(calls).toHaveLength(1); // --version only — no download attempted
  });

  test("refuses with 64 when the manifest has no secretRef", async () => {
    const { exec, calls } = fakeExec({});
    const out = await syncSecrets({ cwd: "/wt", secretRef: undefined, exec });
    expect(out.exitCode).toBe(64);
    expect(calls).toHaveLength(0);
  });

  test("fails with 1 when doppler is missing", async () => {
    const { exec } = fakeExec({ "doppler --version": { stdout: "", exitCode: 127 } });
    const out = await syncSecrets({ cwd: "/wt", secretRef: "s", exec });
    expect(out.exitCode).toBe(1);
  });

  test("pipes the env doppler → kubectl create → kubectl apply, all via stdin", async () => {
    const yaml = "apiVersion: v1\nkind: Secret\n";
    const { exec, calls } = fakeExec({
      "doppler --version": REAL_VERSION,
      "doppler secrets download": ENV_SNAPSHOT,
      "kubectl -n mc-validate create": { stdout: yaml, exitCode: 0 },
      "kubectl -n mc-validate apply": { stdout: "secret/acme-doppler-env configured\n", exitCode: 0 },
    });

    const out = await syncSecrets({ cwd: "/wt", secretRef: "acme-doppler-env", exec });

    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("2 env vars");
    expect(out.message).not.toContain("bar"); // counts only, never values

    const download = calls.find(c => c.argv[1] === "secrets");
    expect(download?.argv).toEqual(["doppler", "secrets", "download", "--no-file", "--format", "env"]);
    expect(download?.cwd).toBe("/wt");

    const create = calls.find(c => c.argv.includes("create"));
    expect(create?.argv).toEqual([
      "kubectl", "-n", "mc-validate", "create", "secret", "generic", "acme-doppler-env",
      "--from-env-file=/dev/stdin", "--dry-run=client", "-o", "yaml",
    ]);
    expect(create?.stdin).toBe(ENV_SNAPSHOT.stdout); // env travels via stdin, not a file

    const apply = calls.find(c => c.argv.includes("apply"));
    expect(apply?.argv).toEqual(["kubectl", "-n", "mc-validate", "apply", "-f", "-"]);
    expect(apply?.stdin).toBe(yaml);
  });

  test("refuses to upsert an empty snapshot", async () => {
    const { exec, calls } = fakeExec({
      "doppler --version": REAL_VERSION,
      "doppler secrets download": { stdout: "\n", exitCode: 0 },
    });
    const out = await syncSecrets({ cwd: "/wt", secretRef: "s", exec });
    expect(out.exitCode).toBe(1);
    expect(calls.some(c => c.argv[0] === "kubectl")).toBe(false);
  });

  test("surfaces kubectl failures as exit 1 without leaking env contents", async () => {
    const { exec } = fakeExec({
      "doppler --version": REAL_VERSION,
      "doppler secrets download": ENV_SNAPSHOT,
      "kubectl -n mc-validate create": { stdout: "", exitCode: 1 },
    });
    const out = await syncSecrets({ cwd: "/wt", secretRef: "s", exec });
    expect(out.exitCode).toBe(1);
    expect(out.message).not.toContain("FOO");
  });
});
