import { describe, expect, test } from "bun:test";

import {
  TUI_CREDENTIALS_EXPIRES_AT_MS,
  isDopplerShim,
  mintTuiCredentialFiles,
  syncAgentCredentials,
  syncBrowserSecrets,
  syncSecrets,
  syncTuiCredentials,
  type Exec,
  type ExecResult,
} from "../cloud-secrets.ts";

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
const JSON_SNAPSHOT: ExecResult = {
  stdout: '{\n  "FOO": "bar",\n  "BAZ_URL": "https://x"\n}\n',
  exitCode: 0,
};

describe("isDopplerShim", () => {
  test("detects the mattcloud shim by its --version output", async () => {
    expect(await isDopplerShim(fakeExec({ "doppler --version": SHIM_VERSION }).exec)).toBe(true);
    expect(await isDopplerShim(fakeExec({ "doppler --version": REAL_VERSION }).exec)).toBe(false);
  });
});

describe("syncSecrets", () => {
  test("refuses the shim with exit 64 before downloading anything", async () => {
    const { exec, calls } = fakeExec({ "doppler --version": SHIM_VERSION });
    const out = await syncSecrets({ cwd: "/wt", secretRef: "assured-doppler-env", exec });
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

  test("pipes the JSON doppler → kubectl apply manifest, all via stdin", async () => {
    const { exec, calls } = fakeExec({
      "doppler --version": REAL_VERSION,
      "doppler secrets download": JSON_SNAPSHOT,
      "kubectl -n mc-validate apply": { stdout: "secret/assured-doppler-env configured\n", exitCode: 0 },
    });

    const out = await syncSecrets({ cwd: "/wt", secretRef: "assured-doppler-env", exec });

    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("2 env vars");
    expect(out.message).not.toContain("bar"); // counts only, never values

    const download = calls.find(c => c.argv[1] === "secrets");
    expect(download?.argv).toEqual(["doppler", "secrets", "download", "--no-file", "--format", "json"]);
    expect(download?.cwd).toBe("/wt");

    const apply = calls.find(c => c.argv.includes("apply"));
    expect(apply?.argv).toEqual(["kubectl", "-n", "mc-validate", "apply", "-f", "-"]);
    // Values reach kubectl through stdin, never argv.
    expect(apply?.argv.join(" ")).not.toContain("bar");
    const manifest = JSON.parse(apply!.stdin!);
    expect(manifest.kind).toBe("Secret");
    expect(manifest.metadata).toEqual({ name: "assured-doppler-env", namespace: "mc-validate" });
    expect(manifest.stringData["doppler.json"]).toBe(JSON_SNAPSHOT.stdout); // verbatim
  });

  test("a value with newlines, quotes, and = survives verbatim into the manifest", async () => {
    const gnarly = JSON.stringify({
      PEM: '-----BEGIN KEY-----\nline"one"\nline=two\n-----END KEY-----\n',
      PLAIN: "x",
    });
    const { exec, calls } = fakeExec({
      "doppler --version": REAL_VERSION,
      "doppler secrets download": { stdout: gnarly, exitCode: 0 },
      "kubectl -n mc-validate apply": { stdout: "ok", exitCode: 0 },
    });

    const out = await syncSecrets({ cwd: "/wt", secretRef: "s", exec });

    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("2 env vars");
    const apply = calls.find(c => c.argv.includes("apply"))!;
    const manifest = JSON.parse(apply.stdin!);
    expect(manifest.stringData["doppler.json"]).toBe(gnarly); // byte-for-byte
    expect(JSON.parse(manifest.stringData["doppler.json"]).PEM)
      .toBe('-----BEGIN KEY-----\nline"one"\nline=two\n-----END KEY-----\n');
  });

  test("refuses to upsert an empty snapshot", async () => {
    const { exec, calls } = fakeExec({
      "doppler --version": REAL_VERSION,
      "doppler secrets download": { stdout: "{}\n", exitCode: 0 },
    });
    const out = await syncSecrets({ cwd: "/wt", secretRef: "s", exec });
    expect(out.exitCode).toBe(1);
    expect(calls.some(c => c.argv[0] === "kubectl")).toBe(false);
  });

  test("refuses a download that is not a JSON object", async () => {
    for (const stdout of ["FOO=bar\n", '["FOO"]', "null"]) {
      const { exec, calls } = fakeExec({
        "doppler --version": REAL_VERSION,
        "doppler secrets download": { stdout, exitCode: 0 },
      });
      const out = await syncSecrets({ cwd: "/wt", secretRef: "s", exec });
      expect(out.exitCode).toBe(1);
      expect(calls.some(c => c.argv[0] === "kubectl")).toBe(false);
    }
  });

  test("surfaces kubectl failures as exit 1 without leaking env contents", async () => {
    const { exec } = fakeExec({
      "doppler --version": REAL_VERSION,
      "doppler secrets download": JSON_SNAPSHOT,
      "kubectl -n mc-validate apply": { stdout: "", exitCode: 1 },
    });
    const out = await syncSecrets({ cwd: "/wt", secretRef: "s", exec });
    expect(out.exitCode).toBe(1);
    expect(out.message).not.toContain("FOO");
  });
});

// ─── Sandbox extensions (slice 2): browser secrets + agent credentials ───────

describe("syncBrowserSecrets", () => {
  test("upserts repo-browser-secrets (mc-sandboxes) with the dotenv under key env, via stdin only", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes apply": { stdout: "ok", exitCode: 0 },
    });
    const out = await syncBrowserSecrets({ content: "USER=me\nPASS=secret\n", exec });
    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("repo-browser-secrets");
    // Values reach kubectl through stdin, never argv.
    expect(calls[0]!.argv.join(" ")).not.toContain("secret");
    const manifest = JSON.parse(calls[0]!.stdin!);
    expect(manifest.metadata).toEqual({ name: "repo-browser-secrets", namespace: "mc-sandboxes" });
    expect(manifest.stringData.env).toBe("USER=me\nPASS=secret\n");
  });

  test("refuses an empty dotenv with 64", async () => {
    const { exec, calls } = fakeExec({});
    const out = await syncBrowserSecrets({ content: "\n", exec });
    expect(out.exitCode).toBe(64);
    expect(calls).toHaveLength(0);
  });
});

describe("syncAgentCredentials", () => {
  test("upserts agent-credentials with base64 data per overlay-named key (binary-safe)", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes get secret agent-credentials": { stdout: "", exitCode: 0 },
      "kubectl -n mc-sandboxes apply": { stdout: "ok", exitCode: 0 },
    });
    const out = await syncAgentCredentials({
      files: { "claude-session.json": new TextEncoder().encode('{"tok":1}') },
      exec,
    });
    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("agent-credentials");
    const manifest = JSON.parse(calls.find(c => c.argv.includes("apply"))!.stdin!);
    expect(manifest.metadata).toEqual({ name: "agent-credentials", namespace: "mc-sandboxes" });
    expect(manifest.data["claude-session.json"]).toBe(Buffer.from('{"tok":1}').toString("base64"));
  });

  test("refuses an empty file set with 64", async () => {
    const { exec, calls } = fakeExec({});
    const out = await syncAgentCredentials({ files: {}, exec });
    expect(out.exitCode).toBe(64);
    expect(calls).toHaveLength(0);
  });

  test("merges into an existing Secret so other repos' credential keys survive (MAT-226)", async () => {
    const EXISTING = JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "agent-credentials", namespace: "mc-sandboxes" },
      data: { "other-repo.pem": Buffer.from("keep").toString("base64") },
    });
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes get secret agent-credentials": { stdout: EXISTING, exitCode: 0 },
      "kubectl -n mc-sandboxes apply": { stdout: "ok", exitCode: 0 },
    });
    const out = await syncAgentCredentials({
      files: { "claude-session.json": new TextEncoder().encode('{"tok":1}') },
      exec,
    });
    expect(out.exitCode).toBe(0);
    const apply = calls.find(c => c.argv.includes("apply"))!;
    expect(JSON.parse(apply.stdin!).data).toEqual({
      "other-repo.pem": Buffer.from("keep").toString("base64"),
      "claude-session.json": Buffer.from('{"tok":1}').toString("base64"),
    });
  });

  test("a failed agent-credentials get aborts with 1 before any apply", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes get secret agent-credentials": { stdout: "", exitCode: 1 },
      "kubectl -n mc-sandboxes apply": { stdout: "ok", exitCode: 0 },
    });
    const out = await syncAgentCredentials({
      files: { "claude-session.json": new TextEncoder().encode("x") },
      exec,
    });
    expect(out.exitCode).toBe(1);
    expect(out.message).toContain("agent-credentials");
    expect(calls.some(c => c.argv.includes("apply"))).toBe(false);
  });
});

// ─── Attended lanes: TUI credential minting + sync (MAT-235) ─────────────────

describe("mintTuiCredentialFiles", () => {
  const minted = mintTuiCredentialFiles({
    token: "sk-ant-oat01-xyz",
    email: "matt@example.dev",
    organizationUuid: "org-uuid-1",
    organizationName: "Example Org",
  });

  test("credentials.json follows the MAT-231 recipe exactly (setup-token shape, far-future expiry)", () => {
    expect(JSON.parse(minted.credentialsJson)).toEqual({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-xyz",
        refreshToken: null,
        expiresAt: TUI_CREDENTIALS_EXPIRES_AT_MS,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
      },
    });
    // Far future in ms, not seconds — the TUI compares against Date.now().
    expect(TUI_CREDENTIALS_EXPIRES_AT_MS).toBeGreaterThan(4e12);
  });

  test("claude.json carries onboarding, the identity block, and /workspace/src pre-trust", () => {
    expect(JSON.parse(minted.claudeJson)).toEqual({
      hasCompletedOnboarding: true,
      theme: "dark",
      oauthAccount: {
        emailAddress: "matt@example.dev",
        organizationUuid: "org-uuid-1",
        organizationName: "Example Org",
        organizationRole: "admin",
      },
      projects: { "/workspace/src": { hasTrustDialogAccepted: true } },
    });
  });
});

describe("syncTuiCredentials", () => {
  const EXISTING = JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "agent-credentials", namespace: "mc-sandboxes" },
    data: { "acct-1.token": Buffer.from("keep").toString("base64") },
  });

  test("mints via the injected identity provider and merge-upserts the two per-account keys", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes get secret agent-credentials": { stdout: EXISTING, exitCode: 0 },
      "kubectl -n mc-sandboxes apply": { stdout: "ok", exitCode: 0 },
    });
    const providerCalls: string[] = [];
    const out = await syncTuiCredentials({
      accountKey: "acct-3",
      token: "sk-ant-oat01-xyz",
      identity: async (accountKey) => {
        providerCalls.push(accountKey);
        return { email: "m@x.dev", organizationUuid: "ou", organizationName: "on" };
      },
      exec,
    });

    expect(out.exitCode).toBe(0);
    expect(out.message).toContain("acct-3");
    expect(out.message).not.toContain("sk-ant-oat01-xyz"); // names only, never the token
    expect(providerCalls).toEqual(["acct-3"]);

    const apply = calls.find(c => c.argv.includes("apply"))!;
    // The token reaches kubectl through stdin, never argv.
    expect(apply.argv.join(" ")).not.toContain("sk-ant-oat01-xyz");
    const data = JSON.parse(apply.stdin!).data as Record<string, string>;
    expect(data["acct-1.token"]).toBe(Buffer.from("keep").toString("base64")); // MAT-226 merge
    const credentials = JSON.parse(Buffer.from(data["acct-3.credentials.json"]!, "base64").toString());
    expect(credentials.claudeAiOauth.accessToken).toBe("sk-ant-oat01-xyz");
    const claude = JSON.parse(Buffer.from(data["acct-3.claude.json"]!, "base64").toString());
    expect(claude.oauthAccount.emailAddress).toBe("m@x.dev");
  });

  test("refuses an empty token with 64 before calling the provider or kubectl", async () => {
    const { exec, calls } = fakeExec({});
    const out = await syncTuiCredentials({
      accountKey: "acct-3",
      token: "  ",
      identity: async () => { throw new Error("provider must not run"); },
      exec,
    });
    expect(out.exitCode).toBe(64);
    expect(calls).toHaveLength(0);
  });

  test("surfaces a failed get as 1 (merge base unavailable)", async () => {
    const { exec, calls } = fakeExec({
      "kubectl -n mc-sandboxes get secret agent-credentials": { stdout: "", exitCode: 1 },
    });
    const out = await syncTuiCredentials({
      accountKey: "acct-3",
      token: "t",
      identity: async () => ({ email: "e", organizationUuid: "u", organizationName: "n" }),
      exec,
    });
    expect(out.exitCode).toBe(1);
    expect(calls.some(c => c.argv.includes("apply"))).toBe(false);
  });
});
