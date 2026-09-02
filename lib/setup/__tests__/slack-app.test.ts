import { describe, test, expect } from "bun:test";
import { buildSlackManifest, DEFAULT_CALLBACK_PORT, DEFAULT_SCOPE_NEEDS } from "../slack-app.ts";
import { setupSlackCreateApp, type ConnectDeps, type SecretWriter, type TeamSecrets } from "../../../commands/setup.ts";
import { fakeProbes } from "./fakes.ts";
import type { SecretPresence } from "../validators/accounts.ts";
import type { TeamSnapshot } from "../team-settings.ts";

describe("buildSlackManifest", () => {
  test("redirect url carries the port; both scope lists present", () => {
    const manifest = buildSlackManifest({ name: "mattstack (acme)", callbackPort: 22222, scopes: DEFAULT_SCOPE_NEEDS }) as {
      oauth_config: { redirect_urls: string[]; scopes: { bot: string[]; user: string[] } };
    };

    expect(manifest.oauth_config.redirect_urls).toEqual(["http://localhost:22222/callback"]);
    expect(manifest.oauth_config.scopes.bot).toEqual(DEFAULT_SCOPE_NEEDS.bot);
    expect(manifest.oauth_config.scopes.user).toEqual(DEFAULT_SCOPE_NEEDS.user);
  });
});

function neverCalled<T extends unknown[], R>(name: string) {
  return async (..._args: T): Promise<R> => {
    throw new Error(`unexpected call: ${name}`);
  };
}

function fakeSecrets(): SecretPresence {
  return { async has() { return null; } };
}

const MANIFEST_CREATE_OK = {
  status: 200,
  body: JSON.stringify({ ok: true, app_id: "A123", credentials: { client_id: "cid", client_secret: "csecret", signing_secret: "ssecret" } }),
  headers: {},
};

/** A snapshot that already carries forge + linear config — the shape the merge fix must preserve. */
const EXISTING_TEAM_SNAPSHOT: TeamSnapshot = {
  slug: "acme",
  integrations: {
    forge: { host: "github.com", provider: "github" },
    linear: { teamKey: "ENG" },
  },
  trackingIdentities: [],
  marketplaces: [],
  plugins: [],
  remote: null,
};

interface CreateAppDepsOpts {
  fetch?: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string; headers: Record<string, string> }>;
  stdin?: () => Promise<unknown>;
  isTTY?: () => boolean;
  promptField?: ConnectDeps["promptField"];
  teamSecretsWrite?: TeamSecrets["write"];
  writeSetting?: ConnectDeps["writeSetting"];
  snapshot?: TeamSnapshot;
}

function createAppDeps(opts: CreateAppDepsOpts = {}): ConnectDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    probes: fakeProbes({ fetch: opts.fetch }),
    secrets: fakeSecrets(),
    print: (s) => lines.push(s),
    exit: (code) => {
      throw new Error(`unexpected exit(${code})`);
    },
    stdin: opts.stdin ?? (async () => ({ configToken: "app-config-tok" })),
    isTTY: opts.isTTY ?? (() => false),
    promptField: opts.promptField ?? neverCalled("promptField"),
    writer: { storeReady: async () => true, write: neverCalled("writer.write") } satisfies SecretWriter,
    teamSecrets: {
      read: neverCalled("teamSecrets.read"),
      write: opts.teamSecretsWrite ?? (async () => ({ staged: false })),
    } satisfies TeamSecrets,
    writeSetting: opts.writeSetting ?? neverCalled("writeSetting"),
    listen: neverCalled("listen"),
    randomState: () => "unused",
    teamSnapshot: () => opts.snapshot ?? EXISTING_TEAM_SNAPSHOT,
    lines,
  };
}

describe("setupSlackCreateApp", () => {
  test("posts the manifest, MERGES mattstack.integrations.slack (forge/linear survive), and writes both team secrets before the settings write", async () => {
    const callOrder: string[] = [];
    const teamSecretWrites: unknown[][] = [];
    const writeSettingCalls: unknown[][] = [];

    const deps = createAppDeps({
      fetch: async (url) => (url === "https://slack.com/api/apps.manifest.create" ? MANIFEST_CREATE_OK : { status: 0, body: "", headers: {} }),
      teamSecretsWrite: async (slug, domain, key, value) => {
        callOrder.push("secret");
        teamSecretWrites.push([slug, domain, key, value]);
        return { staged: false };
      },
      writeSetting: (key, value, scope, opts) => {
        callOrder.push("settings");
        writeSettingCalls.push([key, value, scope, opts]);
      },
    });

    await setupSlackCreateApp(["--json"], {}, deps);

    // Order: both secrets land before the settings write.
    expect(callOrder).toEqual(["secret", "secret", "settings"]);

    expect(writeSettingCalls).toHaveLength(1);
    const [key, value, scope, opts] = writeSettingCalls[0]!;
    expect(key).toBe("mattstack.integrations");
    // MERGE, not replace: forge/linear from the existing snapshot survive alongside the new slack block.
    expect(value).toEqual({
      forge: { host: "github.com", provider: "github" },
      linear: { teamKey: "ENG" },
      slack: { appId: "A123", clientId: "cid", callbackPort: DEFAULT_CALLBACK_PORT },
    });
    expect(scope).toBe("team");
    expect(opts).toEqual({ team: "acme" });

    expect(teamSecretWrites).toContainEqual(["acme", "board", "slackClientSecret", "csecret"]);
    expect(teamSecretWrites).toContainEqual(["acme", "board", "slackSigningSecret", "ssecret"]);

    expect(deps.lines).toHaveLength(1);
    const body = JSON.parse(deps.lines[0]!) as { status: string; integration: string };
    expect(body.status).toBe("ready");
    expect(body.integration).toBe("slack");
  });

  test("an existing slack block in mattstack.integrations is itself overlaid, not replaced wholesale (e.g. a previously-set channel survives)", async () => {
    const writeSettingCalls: unknown[][] = [];
    const snapshot: TeamSnapshot = {
      ...EXISTING_TEAM_SNAPSHOT,
      integrations: { ...EXISTING_TEAM_SNAPSHOT.integrations, slack: { channel: "#ops" } },
    };
    const deps = createAppDeps({
      fetch: async (url) => (url === "https://slack.com/api/apps.manifest.create" ? MANIFEST_CREATE_OK : { status: 0, body: "", headers: {} }),
      snapshot,
      writeSetting: (key, value, scope, opts) => {
        writeSettingCalls.push([key, value, scope, opts]);
      },
    });

    await setupSlackCreateApp(["--json"], {}, deps);

    const value = writeSettingCalls[0]![1] as { slack: Record<string, unknown> };
    expect(value.slack).toEqual({ channel: "#ops", appId: "A123", clientId: "cid", callbackPort: DEFAULT_CALLBACK_PORT });
  });

  test("no age key yet: team secrets stage instead of throwing, settings write still happens, detail says staged", async () => {
    const writeSettingCalls: unknown[][] = [];
    const deps = createAppDeps({
      fetch: async (url) => (url === "https://slack.com/api/apps.manifest.create" ? MANIFEST_CREATE_OK : { status: 0, body: "", headers: {} }),
      teamSecretsWrite: async () => ({ staged: true, reason: "no-age-key" }),
      writeSetting: (key, value, scope, opts) => {
        writeSettingCalls.push([key, value, scope, opts]);
      },
    });

    await setupSlackCreateApp(["--json"], {}, deps);

    expect(writeSettingCalls).toHaveLength(1);
    const body = JSON.parse(deps.lines[0]!) as { status: string; detail: string };
    expect(body.status).toBe("ready");
    expect(body.detail).toBe("Slack app created — team secrets staged until the age key exists");
  });

  // A zero-recipient team (exactly what a freshly-scaffolded team's
  // .sops.yaml looks like before anyone syncs members) must route through
  // the SAME staging fallback as no-age-key, never a hard exit-2 — the
  // Slack app has already been created remotely by this point in the verb,
  // so throwing here would orphan it with an unrecoverable client secret.
  test("zero team recipients: team secrets stage instead of throwing (never exit-2 after the app already exists remotely), detail names the real reason", async () => {
    const writeSettingCalls: unknown[][] = [];
    const deps = createAppDeps({
      fetch: async (url) => (url === "https://slack.com/api/apps.manifest.create" ? MANIFEST_CREATE_OK : { status: 0, body: "", headers: {} }),
      teamSecretsWrite: async () => ({ staged: true, reason: "no-recipients" }),
      writeSetting: (key, value, scope, opts) => {
        writeSettingCalls.push([key, value, scope, opts]);
      },
    });

    await setupSlackCreateApp(["--json"], {}, deps);

    // The settings write (and so the whole verb) still completes — no exit(2).
    expect(writeSettingCalls).toHaveLength(1);
    const body = JSON.parse(deps.lines[0]!) as { status: string; detail: string };
    expect(body.status).toBe("ready");
    expect(body.detail).toBe("Slack app created — team secrets staged until the team has recipients");
  });

  test("a real team-secret store failure exits 2 BEFORE any settings write lands", async () => {
    const writeSettingCalls: unknown[][] = [];
    const deps = createAppDeps({
      fetch: async (url) => (url === "https://slack.com/api/apps.manifest.create" ? MANIFEST_CREATE_OK : { status: 0, body: "", headers: {} }),
      teamSecretsWrite: async () => {
        throw new Error("sops -e team-acme-board: encryption failed");
      },
      writeSetting: (key, value, scope, opts) => {
        writeSettingCalls.push([key, value, scope, opts]);
      },
    });
    // exit(code) throws in this fixture — that's how the test observes exit 2 was requested.
    await expect(setupSlackCreateApp(["--json"], {}, deps)).rejects.toThrow("unexpected exit(2)");

    expect(writeSettingCalls).toEqual([]);
    const payload = JSON.parse(deps.lines[0]!) as { error: { code: string } };
    expect(payload.error.code).toBe("team-secret-write-failed");
  });

  test("isTTY() is checked before stdin is read", async () => {
    let promptCalled = false;
    const deps = createAppDeps({
      fetch: async (url) => (url === "https://slack.com/api/apps.manifest.create" ? MANIFEST_CREATE_OK : { status: 0, body: "", headers: {} }),
      isTTY: () => true,
      stdin: neverCalled("stdin"),
      promptField: async () => {
        promptCalled = true;
        return "app-config-tok-from-prompt";
      },
      teamSecretsWrite: async () => ({ staged: false }),
      writeSetting: () => {},
    });

    await setupSlackCreateApp(["--json"], {}, deps);

    expect(promptCalled).toBe(true);
  });

  test("a trailing newline in the JSON configToken is trimmed before use", async () => {
    let authHeader: string | undefined;
    const deps = createAppDeps({
      fetch: async (url, init) => {
        if (url === "https://slack.com/api/apps.manifest.create") {
          authHeader = init?.headers?.["Authorization"];
          return MANIFEST_CREATE_OK;
        }
        return { status: 0, body: "", headers: {} };
      },
      stdin: async () => ({ configToken: "app-config-tok\n" }),
      teamSecretsWrite: async () => ({ staged: false }),
      writeSetting: () => {},
    });

    await setupSlackCreateApp(["--json"], {}, deps);

    expect(authHeader).toBe("Bearer app-config-tok");
  });

  test("sentinel: neither the config token nor the client/signing secrets reach the printed envelope", async () => {
    const CONFIG_TOKEN_SENTINEL = "sk-config-token-sentinel";
    const CLIENT_SECRET_SENTINEL = "sk-client-secret-sentinel";
    const manifestOkWithSentinelSecrets = {
      status: 200,
      body: JSON.stringify({ ok: true, app_id: "A123", credentials: { client_id: "cid", client_secret: CLIENT_SECRET_SENTINEL, signing_secret: "ssecret" } }),
      headers: {},
    };
    const deps = createAppDeps({
      fetch: async (url) => (url === "https://slack.com/api/apps.manifest.create" ? manifestOkWithSentinelSecrets : { status: 0, body: "", headers: {} }),
      stdin: async () => ({ configToken: CONFIG_TOKEN_SENTINEL }),
      teamSecretsWrite: async () => ({ staged: false }),
      writeSetting: () => {},
    });

    await setupSlackCreateApp(["--json"], {}, deps);

    expect(deps.lines.join("\n")).not.toContain(CONFIG_TOKEN_SENTINEL);
    expect(deps.lines.join("\n")).not.toContain(CLIENT_SECRET_SENTINEL);
  });
});
