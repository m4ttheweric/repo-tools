import { describe, test, expect } from "bun:test";
import { buildSlackManifest, DEFAULT_CALLBACK_PORT, DEFAULT_SCOPE_NEEDS } from "../slack-app.ts";
import { setupSlackCreateApp, type ConnectDeps, type SecretWriter, type TeamSecrets } from "../../../commands/setup.ts";
import { writeIntent, type SetupIntent } from "../intent.ts";
import { fakeProbes } from "./fakes.ts";
import type { SecretPresence } from "../validators/accounts.ts";

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

describe("setupSlackCreateApp", () => {
  test("posts the manifest, writes mattstack.integrations.slack, and writes both team secrets", async () => {
    const p = fakeProbes({
      fetch: async (url) => {
        if (url === "https://slack.com/api/apps.manifest.create") {
          return {
            status: 200,
            body: JSON.stringify({ ok: true, app_id: "A123", credentials: { client_id: "cid", client_secret: "csecret", signing_secret: "ssecret" } }),
            headers: {},
          };
        }
        return { status: 0, body: "", headers: {} };
      },
    });

    const intent: SetupIntent = {
      v: 1,
      at: "2026-08-22T00:00:00.000Z",
      mode: "create",
      team: { slug: "acme", name: "Acme", remote: "https://github.com/o/r.git", others: false },
    };
    writeIntent(p, intent);

    const writeSettingCalls: unknown[][] = [];
    const teamSecretWrites: unknown[][] = [];
    const lines: string[] = [];

    const deps: ConnectDeps = {
      probes: p,
      secrets: fakeSecrets(),
      print: (s) => lines.push(s),
      exit: (code) => {
        throw new Error(`unexpected exit(${code})`);
      },
      stdin: async () => ({ configToken: "app-config-tok" }),
      isTTY: () => false,
      promptField: neverCalled("promptField"),
      writer: { hasAgeKey: async () => true, write: neverCalled("writer.write") } satisfies SecretWriter,
      teamSecrets: {
        read: neverCalled("teamSecrets.read"),
        write: async (slug, domain, key, value) => {
          teamSecretWrites.push([slug, domain, key, value]);
        },
      } satisfies TeamSecrets,
      writeSetting: ((key, value, scope, opts) => {
        writeSettingCalls.push([key, value, scope, opts]);
      }) as ConnectDeps["writeSetting"],
      listen: neverCalled("listen"),
    };

    await setupSlackCreateApp(["--json"], {}, deps);

    expect(writeSettingCalls).toHaveLength(1);
    const [key, value, scope, opts] = writeSettingCalls[0]!;
    expect(key).toBe("mattstack.integrations");
    expect(value).toEqual({ slack: { appId: "A123", clientId: "cid", callbackPort: DEFAULT_CALLBACK_PORT } });
    expect(scope).toBe("team");
    expect(opts).toEqual({ team: "acme" });

    expect(teamSecretWrites).toContainEqual(["acme", "board", "slackClientSecret", "csecret"]);
    expect(teamSecretWrites).toContainEqual(["acme", "board", "slackSigningSecret", "ssecret"]);

    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0]!) as { status: string; integration: string };
    expect(body.status).toBe("ready");
    expect(body.integration).toBe("slack");
  });
});
